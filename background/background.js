/**
 * Background Service Worker
 * Handles extension lifecycle and ALL API fetch requests.
 *
 * WHY here and not in content scripts?
 * Content scripts run in the YouTube page context (HTTPS). Fetching a local
 * Ollama server over plain HTTP would be blocked by Chrome as "mixed content".
 * Background service workers have their own context and can freely fetch any
 * host listed in host_permissions, including http:// endpoints.
 */

// Language name map (inlined to avoid ES-module import issues in SW)
const LANG_NAMES = {
    en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
    es: 'Spanish', fr: 'French', de: 'German', ru: 'Russian',
    pt: 'Portuguese', it: 'Italian', ar: 'Arabic', hi: 'Hindi',
    th: 'Thai', vi: 'Vietnamese', tr: 'Turkish', pl: 'Polish',
    nl: 'Dutch', sv: 'Swedish', uk: 'Ukrainian', id: 'Indonesian'
};

const TRANSLATION_RULES_VERSION = '2026-07-13.4';
const TRANSLATION_CACHE_PREFIX = 'yttr_v2_';
const TRANSLATION_CACHE_INDEX_KEY = '__yb_translation_cache_index_v2';
const TRANSLATION_CACHE_MAX_ENTRIES = 400;
const TRANSLATION_CACHE_MAX_BYTES = 3 * 1024 * 1024;
const activeTranslationTasks = new Map();
let translationCacheMutation = Promise.resolve();
let settingsMutation = Promise.resolve();
let vocabularyMutation = Promise.resolve();

class TranslationError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'TranslationError';
        this.code = options.code || 'TRANSLATION_FAILED';
        this.retryable = Boolean(options.retryable);
        this.stale = Boolean(options.stale);
        this.status = options.status ?? null;
        this.details = options.details || null;
    }
}

function normalizeTranslationError(error, fallbackMessage = 'Translation failed') {
    if (error instanceof TranslationError) return error;
    if (error?.name === 'AbortError') {
        return new TranslationError('Translation request was cancelled.', {
            code: 'REQUEST_CANCELLED',
            retryable: false
        });
    }
    return new TranslationError(error?.message || fallbackMessage, {
        code: error?.code || 'TRANSLATION_FAILED',
        retryable: Boolean(error?.retryable),
        stale: Boolean(error?.stale),
        details: error?.details || null
    });
}

function sendTranslationError(sendResponse, error, taskId = null) {
    const normalized = normalizeTranslationError(error);
    sendResponse({
        success: false,
        error: normalized.message,
        errorCode: normalized.code,
        retryable: normalized.retryable,
        stale: normalized.stale,
        details: normalized.details,
        taskId
    });
}

function getTaskIdentity(message, sender) {
    const task = message.task && typeof message.task === 'object' ? message.task : {};
    const id = message.taskId ?? message.taskGeneration ?? task.id ?? null;
    if (id === null || id === undefined || id === '') return null;
    const tabId = sender?.tab?.id ?? 'global';
    const callerScope = String(message.taskScope ?? message.taskKey ?? task.scope ?? 'translation');
    return {
        id: String(id),
        scope: `${tabId}:${callerScope}`
    };
}

function cancelTranslationTasksForSender(sender, requestedScope = '') {
    const tabId = sender?.tab?.id ?? 'global';
    const prefix = `${tabId}:`;
    const exactScope = requestedScope ? `${prefix}${String(requestedScope)}` : '';
    let cancelled = 0;

    for (const [scope, generation] of activeTranslationTasks.entries()) {
        if (!scope.startsWith(prefix) || (exactScope && scope !== exactScope)) continue;
        for (const controller of generation.controllers) controller.abort('translation-session-cancelled');
        activeTranslationTasks.delete(scope);
        cancelled++;
    }
    return cancelled;
}

function beginTranslationTask(message, sender) {
    const identity = getTaskIdentity(message, sender);
    if (!identity) {
        return {
            signal: null,
            assertCurrent() {},
            release() {}
        };
    }

    let generation = activeTranslationTasks.get(identity.scope);
    if (!generation || generation.id !== identity.id) {
        if (generation) {
            for (const controller of generation.controllers) {
                controller.abort('stale-translation-task');
            }
        }
        generation = { id: identity.id, controllers: new Set() };
        activeTranslationTasks.set(identity.scope, generation);
    }

    const controller = new AbortController();
    generation.controllers.add(controller);

    const assertCurrent = () => {
        const current = activeTranslationTasks.get(identity.scope);
        if (!current || current.id !== identity.id || controller.signal.aborted) {
            throw new TranslationError('Discarded a stale translation result.', {
                code: 'STALE_TRANSLATION_TASK',
                retryable: false,
                stale: true
            });
        }
    };

    return {
        taskId: identity.id,
        taskScope: identity.scope,
        signal: controller.signal,
        assertCurrent,
        release() {
            generation.controllers.delete(controller);
            if (generation.controllers.size === 0 && activeTranslationTasks.get(identity.scope) === generation) {
                activeTranslationTasks.delete(identity.scope);
            }
        }
    };
}

function runTranslationMessage(message, sender, sendResponse, handler) {
    const task = beginTranslationTask(message, sender);
    Promise.resolve()
        .then(() => handler(task))
        .then(result => {
            task.assertCurrent();
            sendResponse({ success: true, result, taskId: task.taskId || null });
        })
        .catch(error => sendTranslationError(sendResponse, error, task.taskId || null))
        .finally(() => task.release());
    return true;
}

function updateStoredSettings(patch = {}) {
    const operation = settingsMutation.then(() => new Promise((resolve, reject) => {
        chrome.storage.sync.get('settings', result => {
            if (chrome.runtime?.lastError) {
                reject(new Error(chrome.runtime.lastError.message || 'Could not read settings.'));
                return;
            }
            const settings = { ...(result?.settings || {}), ...(patch || {}) };
            chrome.storage.sync.set({ settings }, () => {
                if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message || 'Could not save settings.'));
                else resolve(settings);
            });
        });
    }));
    settingsMutation = operation.catch(() => undefined);
    return operation;
}

function updateStoredVocabularyEntry(entry = {}) {
    const operation = vocabularyMutation.then(async () => {
        const stored = await storageLocalGet('vocabulary');
        const vocabulary = { ...(stored.vocabulary || {}) };
        const word = String(entry.word || '').trim().toLowerCase();
        const language = String(entry.language || '').trim();
        if (!word || !language) throw new Error('Word and language are required.');
        const key = `${language}:${word}`;
        vocabulary[key] = {
            word,
            status: entry.status === 'known' ? 'known' : 'learning',
            definition: String(entry.definition || ''),
            language,
            updatedAt: Date.now()
        };
        await storageLocalSet({ vocabulary });
        return vocabulary[key];
    });
    vocabularyMutation = operation.catch(() => undefined);
    return operation;
}

// ─── Install / Update ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.storage.sync.get('settings', (result) => {
            if (!result.settings) {
                chrome.storage.sync.set({
                    settings: {
                        enabled: true,
                        targetLanguage: 'en',
                        nativeLanguage: 'zh',
                        proficiencyLevel: 'middle',
                        aiProvider: 'local',
                        apiKey: '',
                        apiEndpoint: 'https://api.openai.com/v1/chat/completions',
                        apiModel: 'gpt-4o-mini',
                        localEndpoint: 'http://localhost:11434/api/generate',
                        localModel: 'qwen2.5:14b',
                        showPanel: false,
                        subtitleDisplayMode: 'bilingual',
                        fontSize: 16,
                        subtitlePosition: 'bottom',
                        subtitleBackgroundOpacity: 0.84,
                        knownWordColor: '#4CAF50',
                        unknownWordColor: '#FF9800',
                        autoTranslate: true,
                        useAITranslation: false,
                        enableLogging: true,
                        webPageTranslation: false,
                        showOriginalSubtitle: true,
                        showTranslatedSubtitle: true
                    }
                });
            }
        });
        chrome.runtime.openOptionsPage();
    }
});

// ─── Badge ───────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.settings) {
        const enabled = changes.settings.newValue?.enabled;
        chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    }
});

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateSettings') {
        updateStoredSettings(message.patch || {})
            .then(settings => sendResponse({ success: true, settings }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.action === 'saveVocabularyEntry') {
        updateStoredVocabularyEntry(message.entry || {})
            .then(entry => sendResponse({ success: true, entry }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.action === 'cancelTranslationTasks') {
        const count = cancelTranslationTasksForSender(sender, message.taskScope || '');
        sendResponse({ success: true, count });
        return false;
    }

    if (message.action === 'translate') {
        return runTranslationMessage(message, sender, sendResponse, task => handleTranslate(
            message.text, message.targetLang, message.nativeLang,
            message.settings, message.context || [], false, message.mode || 'quality', task
        ));
    }

    if (message.action === 'translateStructuredBlock') {
        return runTranslationMessage(message, sender, sendResponse, task => handleStructuredBlockTranslate(
            message.segments, message.targetLang, message.nativeLang,
            message.settings, message.context || [], task
        ));
    }

    if (message.action === 'translateBlock') {
        return runTranslationMessage(message, sender, sendResponse, task => handleBlockTranslate(
            message.segments, message.targetLang, message.nativeLang,
            message.settings, message.context || [], task
        ));
    }

    if (message.action === 'translateWebParagraphs') {
        return runTranslationMessage(message, sender, sendResponse, task => handleWebPageTranslate(
            message.paragraphs, message.targetLang, message.nativeLang,
            message.settings, message.context || [], task
        ));
    }

    if (message.action === 'getDefinition') {
        handleDefinition(message.word, message.context, message.targetLang, message.nativeLang, message.settings)
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'clearCache') {
        // Remove only translation/definition cache keys, keep settings & vocab
        chrome.storage.local.get(null, (items) => {
            const keysToRemove = Object.keys(items).filter(k =>
                k.startsWith('tr_') || k.startsWith('def_') || k.startsWith('dict_') ||
                k.startsWith('blk_') || k.startsWith('sblk_') || k.startsWith('wp_') ||
                k.startsWith(TRANSLATION_CACHE_PREFIX) || k === TRANSLATION_CACHE_INDEX_KEY
            );
            if (keysToRemove.length) {
                chrome.storage.local.remove(keysToRemove, () => {
                    sendResponse({ success: true, count: keysToRemove.length });
                });
            } else {
                sendResponse({ success: true, count: 0 });
            }
        });
        return true;
    }

    if (message.action === 'dictLookup') {
        handleDictLookup(message.word, message.nativeLang || 'zh')
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'testConnection') {
        const s = message.settings || {};
        // Validate required fields before attempting network call
        if (s.aiProvider !== 'local' && !s.apiKey) {
            sendResponse({ success: false, error: 'API Key is empty. Please fill in your API Key.' });
            return true;
        }
        if (s.aiProvider !== 'local' && !s.apiEndpoint) {
            sendResponse({ success: false, error: 'API Endpoint is empty.' });
            return true;
        }
        if (s.aiProvider === 'local' && !s.localEndpoint) {
            sendResponse({ success: false, error: 'Local Endpoint is empty.' });
            return true;
        }
        if (s.aiProvider === 'local' && !s.localModel) {
            sendResponse({ success: false, error: 'Model Name is empty.' });
            return true;
        }
        // skipCache=true so we always make a real network request
        handleTranslate('Great, the connection works.', 'en', 'zh', s, [], true, 'fast')
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'openOptions') {
        chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
    }

    if (message.action === 'downloadLog') {
        const { filename, content } = message;
        // Clean filename and add prefix
        const safeName = `YT_Bilingual_${filename.replace(/[<>:"/\\|?*]/g, '_')}.txt`;
        const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;

        chrome.downloads.download({
            url: dataUrl,
            filename: safeName,
            saveAs: true,
            conflictAction: 'uniquify'
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ success: true, downloadId });
            }
        });
        return true;
    }

    return true;
});

// ─── Translation ──────────────────────────────────────────────────────────────

/**
 * Extract the final translation from LLM output that may contain
 * the full Translate-Reflect-Refine thought process.
 * Uses multiple fallback strategies.
 */
function extractFinalTranslation(raw, nativeLang) {
    if (!raw) return '';

    // Strategy 1: <FINAL>...</FINAL> tags (ideal case)
    const finalMatch = raw.match(/<FINAL>([\s\S]*?)<\/FINAL>/i);
    if (finalMatch) return finalMatch[1].trim();

    // Strategy 2: Look for "Refined Translation:" or "Final Translation:" label
    // and take everything after it (the last such label wins)
    const labelMatch = raw.match(/(?:refined|final|polished)\s*translation[:\s]*\*{0,2}\s*(.+?)(?:\n|$)/gi);
    if (labelMatch) {
        // Take the last match (the final refined one)
        const last = labelMatch[labelMatch.length - 1];
        const extracted = last.replace(/(?:refined|final|polished)\s*translation[:\s]*\*{0,2}\s*/i, '').trim();
        if (extracted) return extracted;
    }

    // Strategy 3: For CJK languages, extract the last segment that contains
    // mostly CJK characters (the final translation is usually at the end)
    if (['zh', 'ja', 'ko'].includes(nativeLang)) {
        // Split by common delimiters and find CJK-heavy segments
        const segments = raw.split(/(?:\n|(?:\*\*\d+\.)|\d+\.\s)/);
        const cjkSegments = segments
            .map(s => s.replace(/\*+/g, '').trim())
            .filter(s => {
                if (!s || s.length < 2) return false;
                const cjkChars = (s.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
                return cjkChars / s.length > 0.4; // at least 40% CJK
            });
        if (cjkSegments.length > 0) {
            // Return the last CJK-heavy segment (most likely the refined translation)
            return cjkSegments[cjkSegments.length - 1]
                .replace(/^["""「」『』：:]\s*/, '')
                .replace(/["""「」『』]\s*$/, '')
                .trim();
        }
    }

    // Strategy 4: If all else fails, return raw but truncated
    // (strip obvious preamble like "Of course..." or "Sure...")
    let cleaned = raw
        .replace(/^(?:of course|sure|certainly|i will|let me|here)[^.!]*[.!]\s*/i, '')
        .replace(/\*\*[^*]+\*\*/g, '') // remove **bold** markers
        .replace(/\s{2,}/g, ' ')
        .trim();

    return cleaned;
}

function normalizeTranslationText(text) {
    return (text || '')
        .trim()
        .replace(/\\n/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^["「『]|["」』]$/g, '')
        .trim();
}

function buildRecentContextBlock(context = []) {
    if (!context || context.length === 0) return '';

    const lines = context
        .slice(-5)
        .map(c => `  [${c.original}] → [${c.translated}]`)
        .join('\n');
    return `\nRecent subtitles for terminology, pronouns, and tone only (do NOT retranslate or copy facts from them):\n${lines}\n`;
}

function buildVideoTopicBlock(settings = {}) {
    const title = String(settings.translationVideoTitle || '')
        .replace(/\s+-\s+YouTube\s*$/i, '')
        .trim()
        .slice(0, 200);
    return title ? `\nVideo title/topic (context only): ${title}\n` : '';
}

function buildSubtitleQualityRules(nativeLanguageName) {
    return `SUBTITLE QUALITY RULES:
- Write concise, natural spoken ${nativeLanguageName}; understand the complete thought before wording each subtitle.
- Preserve the speaker's intent, who did what, questions, negation, conditions, comparisons, numbers, units, and list items.
- Keep names, brands, product names, acronyms, code identifiers, commands, flags, paths, filenames, URLs, and keyboard shortcuts unchanged unless there is a well-established localized name.
- Keep terminology and names consistent with accepted translations in the recent context and in this block.
- The source may come from speech recognition. Correct only an obvious recognition error supported by nearby source text and established terminology; otherwise translate conservatively without guessing.
- Context is only for disambiguation, terminology, pronouns, and tone. Never add context-only facts to the requested subtitle.`;
}

function stableSerialize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function hashStableText(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
        h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
    }
    return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${text.length.toString(16)}`;
}

function normalizeCacheContext(context = []) {
    return (context || []).slice(-5).map(item => ({
        original: String(item?.original || ''),
        translated: String(item?.translated || '')
    }));
}

function createTranslationCacheIdentity(kind, sourceText, targetLang, nativeLang, settings, context = [], extra = {}) {
    const provider = settings?.aiProvider || 'openai';
    const endpoint = provider === 'local' ? settings?.localEndpoint : settings?.apiEndpoint;
    const model = provider === 'local' ? settings?.localModel : settings?.apiModel;
    return {
        schema: 2,
        kind,
        sourceText: String(sourceText || ''),
        targetLang: String(targetLang || ''),
        nativeLang: String(nativeLang || ''),
        provider,
        endpoint: String(endpoint || '').replace(/\?.*$/, '').replace(/\/+$/, ''),
        model: String(model || ''),
        rulesVersion: TRANSLATION_RULES_VERSION,
        context: normalizeCacheContext(context),
        extra
    };
}

function translationCacheKey(identity) {
    return `${TRANSLATION_CACHE_PREFIX}${identity.kind}_${hashStableText(stableSerialize(identity))}`;
}

function storageLocalGet(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, result => {
            if (chrome.runtime?.lastError) {
                reject(new TranslationError(`Cache read failed: ${chrome.runtime.lastError.message}`, {
                    code: 'CACHE_READ_FAILED',
                    retryable: true
                }));
                return;
            }
            resolve(result || {});
        });
    });
}

function storageLocalSet(values) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(values, () => {
            if (chrome.runtime?.lastError) {
                reject(new TranslationError(`Cache write failed: ${chrome.runtime.lastError.message}`, {
                    code: 'CACHE_WRITE_FAILED',
                    retryable: true
                }));
                return;
            }
            resolve();
        });
    });
}

function storageLocalRemove(keys) {
    return new Promise((resolve, reject) => {
        if (!keys || (Array.isArray(keys) && keys.length === 0)) return resolve();
        chrome.storage.local.remove(keys, () => {
            if (chrome.runtime?.lastError) {
                reject(new TranslationError(`Cache cleanup failed: ${chrome.runtime.lastError.message}`, {
                    code: 'CACHE_CLEANUP_FAILED',
                    retryable: true
                }));
                return;
            }
            resolve();
        });
    });
}

function withTranslationCacheLock(operation) {
    const run = translationCacheMutation.then(operation, operation);
    translationCacheMutation = run.catch(() => {});
    return run;
}

function estimateCacheBytes(value) {
    const serialized = JSON.stringify(value);
    return typeof TextEncoder !== 'undefined'
        ? new TextEncoder().encode(serialized).length
        : serialized.length * 2;
}

async function getVerifiedTranslationCache(identity, requestOptions = {}) {
    requestOptions.assertCurrent?.();
    const key = translationCacheKey(identity);
    const canonicalIdentity = stableSerialize(identity);
    return withTranslationCacheLock(async () => {
        const stored = await storageLocalGet([key, TRANSLATION_CACHE_INDEX_KEY]);
        const entry = stored[key];
        if (!entry || entry.version !== 2 || entry.identity !== canonicalIdentity || entry.sourceText !== identity.sourceText) {
            return null;
        }

        const now = Date.now();
        const index = stored[TRANSLATION_CACHE_INDEX_KEY] || {};
        index[key] = { size: entry.size || estimateCacheBytes(entry), lastAccessed: now };
        entry.lastAccessed = now;
        await storageLocalSet({ [key]: entry, [TRANSLATION_CACHE_INDEX_KEY]: index });
        requestOptions.assertCurrent?.();
        return entry.value;
    });
}

async function setVerifiedTranslationCache(identity, value, requestOptions = {}) {
    requestOptions.assertCurrent?.();
    const key = translationCacheKey(identity);
    const now = Date.now();
    const entry = {
        version: 2,
        identity: stableSerialize(identity),
        sourceText: identity.sourceText,
        value,
        createdAt: now,
        lastAccessed: now
    };
    entry.size = estimateCacheBytes(entry);
    if (entry.size > TRANSLATION_CACHE_MAX_BYTES) return false;

    return withTranslationCacheLock(async () => {
        const stored = await storageLocalGet(TRANSLATION_CACHE_INDEX_KEY);
        const index = stored[TRANSLATION_CACHE_INDEX_KEY] || {};
        index[key] = { size: entry.size, lastAccessed: now };

        const ordered = Object.entries(index).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
        let totalBytes = ordered.reduce((sum, [, meta]) => sum + (meta.size || 0), 0);
        const remove = [];
        while (ordered.length > TRANSLATION_CACHE_MAX_ENTRIES || totalBytes > TRANSLATION_CACHE_MAX_BYTES) {
            const [oldKey, meta] = ordered.shift();
            if (oldKey === key && ordered.length === 0) break;
            delete index[oldKey];
            remove.push(oldKey);
            totalBytes -= meta.size || 0;
        }

        requestOptions.assertCurrent?.();
        await storageLocalSet({ [key]: entry, [TRANSLATION_CACHE_INDEX_KEY]: index });
        await storageLocalRemove(remove);
        return true;
    });
}

async function readTranslationCache(identity, requestOptions = {}) {
    try {
        return await getVerifiedTranslationCache(identity, requestOptions);
    } catch (error) {
        if (error?.stale || error?.code === 'REQUEST_CANCELLED') throw error;
        console.warn('[YT Bilingual] Translation cache read skipped:', error.message);
        return null;
    }
}

async function writeTranslationCache(identity, value, requestOptions = {}) {
    try {
        return await setVerifiedTranslationCache(identity, value, requestOptions);
    } catch (error) {
        requestOptions.assertCurrent?.();
        console.warn('[YT Bilingual] Translation cache write skipped:', error.message);
        return false;
    }
}

function boundedNumber(value, fallback, min, max) {
    const number = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

function getRequestPolicy(settings = {}, provider = 'cloud') {
    const defaultTimeout = provider === 'local' ? 60000 : 20000;
    const requestedTimeout = provider === 'local'
        ? (settings.localTranslationTimeoutMs ?? settings.translationTimeoutMs)
        : settings.translationTimeoutMs;
    return {
        timeoutMs: boundedNumber(requestedTimeout, defaultTimeout, 50, 300000),
        maxRetries: boundedNumber(settings.translationMaxRetries, provider === 'local' ? 0 : 1, 0, 4),
        retryBaseDelayMs: boundedNumber(settings.translationRetryDelayMs, 400, 0, 10000)
    };
}

function assertRequestCurrent(requestOptions = {}) {
    requestOptions.assertCurrent?.();
    if (requestOptions.signal?.aborted) {
        requestOptions.assertCurrent?.();
        throw new TranslationError('Translation request was cancelled.', {
            code: 'REQUEST_CANCELLED',
            retryable: false
        });
    }
}

function waitForRetry(delayMs, requestOptions = {}) {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const signal = requestOptions.signal;
        const finish = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            try {
                requestOptions.assertCurrent?.();
                reject(new TranslationError('Translation request was cancelled.', {
                    code: 'REQUEST_CANCELLED',
                    retryable: false
                }));
            } catch (error) {
                reject(error);
            }
        };
        if (!signal) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
}

function isRetryableStatus(status) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfterMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function fetchAttempt(url, init, timeoutMs, requestOptions = {}) {
    assertRequestCurrent(requestOptions);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort('translation-timeout');
    }, timeoutMs);
    const onExternalAbort = () => controller.abort('stale-translation-task');
    requestOptions.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        assertRequestCurrent(requestOptions);
        return response;
    } catch (error) {
        if (requestOptions.signal?.aborted) {
            requestOptions.assertCurrent?.();
            throw new TranslationError('Translation request was cancelled.', {
                code: 'REQUEST_CANCELLED',
                retryable: false
            });
        }
        if (timedOut) {
            throw new TranslationError(`Translation request timed out after ${timeoutMs} ms.`, {
                code: 'REQUEST_TIMEOUT',
                retryable: true
            });
        }
        throw new TranslationError(error?.message || 'Network request failed.', {
            code: 'NETWORK_ERROR',
            retryable: true
        });
    } finally {
        clearTimeout(timeout);
        requestOptions.signal?.removeEventListener('abort', onExternalAbort);
    }
}

async function requestJsonWithRetry(url, init, settings, provider, requestOptions = {}) {
    const policy = getRequestPolicy(settings, provider);
    let lastError = null;
    for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        try {
            const response = await fetchAttempt(url, init, policy.timeoutMs, requestOptions);
            if (!response.ok) {
                const body = await response.text();
                const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
                throw new TranslationError(`${provider === 'local' ? 'Local model' : 'API'} error ${response.status}: ${body.slice(0, 300)}`, {
                    code: 'HTTP_ERROR',
                    retryable: isRetryableStatus(response.status),
                    status: response.status,
                    details: retryAfterMs !== null ? { retryAfterMs } : null
                });
            }
            try {
                const data = await response.json();
                assertRequestCurrent(requestOptions);
                return requestOptions.validateResponse
                    ? requestOptions.validateResponse(data)
                    : data;
            } catch (error) {
                if (error instanceof TranslationError) throw error;
                throw new TranslationError('The translation service returned invalid JSON.', {
                    code: 'INVALID_SERVICE_RESPONSE',
                    retryable: true
                });
            }
        } catch (error) {
            lastError = normalizeTranslationError(error);
            if (!lastError.retryable || attempt >= policy.maxRetries) {
                lastError.details = { ...(lastError.details || {}), attempts: attempt + 1 };
                throw lastError;
            }
            const retryDelay = Math.min(
                30000,
                lastError.details?.retryAfterMs ?? policy.retryBaseDelayMs * (2 ** attempt)
            );
            await waitForRetry(retryDelay, requestOptions);
        }
    }
    throw lastError || new TranslationError('Translation request failed.', { retryable: true });
}

function normalizeComparableText(text) {
    return String(text || '').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function extractNumericTokens(text) {
    return (String(text || '').match(/\d+(?:[.,:]\d+)*/g) || [])
        .map(token => token.replace(/[,:.]/g, ''))
        .filter(Boolean);
}

function extractTechnicalTokens(text) {
    // Acronyms such as AI, API, UI, and CLI may be translated naturally into
    // the target language, so requiring their literal spelling rejects valid
    // translations. Only guard tokens that behave like identifiers: mixed-case
    // product names, model/version identifiers containing digits, and file names.
    const candidates = String(text || '').match(/\b(?:[A-Z]?[a-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Za-z]+[-_.]?\d+[A-Za-z0-9._-]*|\w+\.\w{2,5})\b/g) || [];
    return Array.from(new Set(candidates.filter(token => token.length > 1)));
}

function targetScriptPattern(language) {
    if (language === 'zh') return /[\u3400-\u9fff]/g;
    if (language === 'ja') return /[\u3040-\u30ff\u3400-\u9fff]/g;
    if (language === 'ko') return /[\uac00-\ud7af]/g;
    if (language === 'ar') return /[\u0600-\u06ff]/g;
    if (language === 'hi') return /[\u0900-\u097f]/g;
    if (language === 'th') return /[\u0e00-\u0e7f]/g;
    if (language === 'ru' || language === 'uk') return /[\u0400-\u04ff]/g;
    return /[A-Za-z\u00c0-\u024f]/g;
}

function validateTranslationCandidate(segment, translation, targetLang, nativeLang, options = {}) {
    const source = String(segment?.text ?? segment ?? '').trim();
    const translated = normalizeTranslationText(translation);
    const reasons = [];
    const warnings = [];

    if (!translated) reasons.push('empty');
    if (options.truncated) reasons.push('truncated');
    if (!source) return { valid: Boolean(translated), translation: translated, reasons, warnings };
    if (!translated) return { valid: false, translation: '', reasons, warnings };

    const sourceComparable = normalizeComparableText(source);
    const translatedComparable = normalizeComparableText(translated);
    const sourceAlphabetic = source.match(/\p{L}/gu) || [];
    const sourceWords = source.match(/\p{L}+/gu) || [];
    const hasNaturalLanguageWords = sourceWords.some(word =>
        word === word.toLocaleLowerCase() || /^[A-Z][a-z]{1,}$/.test(word)
    );
    if (targetLang !== nativeLang && hasNaturalLanguageWords && sourceComparable === translatedComparable) {
        reasons.push('source-repeated');
    }

    for (const number of extractNumericTokens(source)) {
        if (!extractNumericTokens(translated).includes(number)) {
            reasons.push(`missing-number:${number}`);
        }
    }

    const translatedLower = translated.toLocaleLowerCase();
    for (const token of extractTechnicalTokens(source)) {
        if (!translatedLower.includes(token.toLocaleLowerCase())) {
            warnings.push(`missing-token:${token}`);
        }
    }

    const sourceLetters = source.match(/[\p{L}\p{N}]/gu) || [];
    const scriptMatches = translated.match(targetScriptPattern(nativeLang)) || [];
    const translatedLetters = translated.match(/[\p{L}\p{N}]/gu) || [];
    const mostlyTechnical = extractTechnicalTokens(source).join('').length >= sourceLetters.length * 0.7;
    if (sourceAlphabetic.length >= 4 && !mostlyTechnical && scriptMatches.length / Math.max(1, translatedLetters.length) < 0.15) {
        warnings.push('target-language-mismatch');
    }

    const sourceLength = source.replace(/\s/g, '').length;
    const translatedLength = translated.replace(/\s/g, '').length;
    if (sourceLength >= 12) {
        const ratio = translatedLength / sourceLength;
        if (ratio < 0.08) warnings.push('too-short');
        if (ratio > 8) warnings.push('too-long-ratio');
    }
    if (translatedLength > 600) reasons.push('too-long');

    return { valid: reasons.length === 0, translation: translated, reasons, warnings };
}

function validateTranslationMap(segments, result, targetLang, nativeLang, metadata = {}) {
    const valid = {};
    const invalid = {};
    const nonEmptyIds = (segments || [])
        .map(segment => String(segment.id))
        .filter(id => result[id]);
    const truncatedId = metadata.truncated ? nonEmptyIds[nonEmptyIds.length - 1] : null;
    const duplicateIds = new Set(metadata.duplicateIds || []);

    for (const segment of segments || []) {
        const id = String(segment.id);
        const check = validateTranslationCandidate(segment, result[id], targetLang, nativeLang, {
            truncated: id === truncatedId || duplicateIds.has(id)
        });
        if (check.valid) valid[id] = check.translation;
        else invalid[id] = check.reasons.length ? check.reasons : ['missing-id'];
    }
    return { valid, invalid };
}

async function handleTranslate(text, targetLang, nativeLang, settings, context = [], skipCache = false, mode = 'quality', requestOptions = {}) {
    if (!text || !text.trim()) return '';

    const cacheIdentity = createTranslationCacheIdentity(
        'single', text, targetLang, nativeLang, settings, context, {
            mode,
            videoTitle: String(settings?.translationVideoTitle || '')
        }
    );
    if (!skipCache) {
        const cached = await readTranslationCache(cacheIdentity, requestOptions);
        if (cached) return cached;
    }

    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;
    const qualityRules = buildSubtitleQualityRules(nName);

    // Build context block from recent subtitles
    const contextLines = buildVideoTopicBlock(settings) + buildRecentContextBlock(context);
    const contextBlock = contextLines ? `\n\n${contextLines}` : '';

    let system, userMsg, translation;

    if (mode === 'fast') {
        // ── Fast mode ────────────────────────────────────────────────────
        // For real-time fallback when subtitle is already on screen.
        // Single-pass, minimal prompt, strict token cap.
        system = `Translate the requested ${tName} subtitle to ${nName}.
${qualityRules}
Output ONLY the final translation on one line.`;
        userMsg = `${contextBlock}\n${text}`;

        if (settings.aiProvider === 'local') {
            translation = await fetchOllama(`${system}\n\n${userMsg}`, settings, 120, requestOptions);
        } else {
            translation = await fetchOpenAI(system, userMsg, settings, 200, requestOptions);
        }
    } else {
        // ── Quality mode (default) ────────────────────────────────────────
        // Used during pre-translation where we have enough time for a polished result.
        system = `You are an expert subtitle translator (${tName} to ${nName}).
${qualityRules}
Output ONLY the final translation on one line. Do not show analysis, alternatives, labels, or notes.`;
        userMsg = `${contextBlock}\nTranslate this subtitle:\n${text}`;

        if (settings.aiProvider === 'local') {
            translation = await fetchOllama(`${system}\n\n${userMsg}`, settings, 800, requestOptions);
        } else {
            translation = await fetchOpenAI(system, userMsg, settings, 1000, requestOptions);
        }

        // Robust extraction: LLM sometimes dumps its entire thought process.
        // Try multiple strategies to extract ONLY the final translation.
        translation = extractFinalTranslation(translation || '', nativeLang);
    }

    // Strip accidental quotes, whitespace, and any newlines
    translation = normalizeTranslationText(translation);

    const validation = validateTranslationCandidate({ text }, translation, targetLang, nativeLang);
    if (!validation.valid) {
        throw new TranslationError(`Translation failed quality checks: ${validation.reasons.join(', ')}`, {
            code: 'TRANSLATION_VALIDATION_FAILED',
            retryable: true,
            details: { reasons: validation.reasons }
        });
    }

    requestOptions.assertCurrent?.();
    await writeTranslationCache(cacheIdentity, validation.translation, requestOptions);
    return validation.translation;
}

// ─── Block Translation (numbered segments) ────────────────────────────────────

/**
 * Translate a block of numbered subtitle segments.
 * AI sees the full context but translates each line separately,
 * returning numbered translations for perfect alignment.
 *
 * @param {Array<{id: number, text: string}>} segments
 * @param {string} targetLang
 * @param {string} nativeLang
 * @param {object} settings
 * @param {Array} context
 * @returns {Object} - Map of { id: translatedText }
 */
async function handleBlockTranslate(segments, targetLang, nativeLang, settings, context = [], requestOptions = {}) {
    if (!segments || !segments.length) return {};

    const blockText = JSON.stringify(segments.map(s => ({
        id: String(s.id),
        text: s.text,
        prevText: s.prevText || '',
        nextText: s.nextText || '',
        displayBreakReason: s.displayBreakReason || ''
    })));
    const cacheIdentity = createTranslationCacheIdentity(
        'numbered-block', blockText, targetLang, nativeLang, settings, context, {
            videoTitle: String(settings?.translationVideoTitle || '')
        }
    );
    const cached = await readTranslationCache(cacheIdentity, requestOptions);
    if (cached) {
        const cachedCheck = validateTranslationMap(segments, cached, targetLang, nativeLang);
        if (Object.keys(cachedCheck.invalid).length === 0) return cachedCheck.valid;
    }

    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;
    const qualityRules = buildSubtitleQualityRules(nName);

    // Build numbered input lines with neighboring source-only hints.
    const numberedLines = segments.map(s => {
        const lines = [`[${s.id}] CURRENT: ${s.text}`];
        if (s.prevText) lines.push(`PREV_SOURCE: ${s.prevText}`);
        if (s.nextText) lines.push(`NEXT_SOURCE: ${s.nextText}`);
        if (s.displayBreakReason) lines.push(`BREAK_REASON: ${s.displayBreakReason}`);
        return lines.join('\n');
    }).join('\n\n');

    const contextBlock = buildVideoTopicBlock(settings) + buildRecentContextBlock(context);

    const system = `You are an expert subtitle translator (${tName} to ${nName}).
Each numbered item [N] is a semantic subtitle unit reconstructed from adjacent source timings.
Translate EACH semantic unit naturally and preserve the numbering.

${qualityRules}
- Treat the numbered items in order as continuous speech, but write each CURRENT unit as complete, idiomatic ${nName} rather than copying English word order or source timing breaks.
- Reorder words and clauses freely inside CURRENT when ${nName} requires it.
- PREV_SOURCE and NEXT_SOURCE are context hints only. Use them to resolve meaning, pronouns, and terminology without adding their facts to CURRENT.
- Return exactly one complete translation for every semantic unit.
- Output ONLY the translations inside <TRANSLATIONS></TRANSLATIONS> tags.
- Format: one line per item, exactly like [1] 翻译内容`;

    const userMsg = `${contextBlock}
Translate these subtitle segments:
${numberedLines}`;

    let modelResponse;
    const modelOptions = { ...requestOptions, withMetadata: true, allowTruncated: true };
    if (settings.aiProvider === 'local') {
        modelResponse = await fetchOllama(`${system}\n\n${userMsg}`, settings, 1200, modelOptions);
    } else {
        modelResponse = await fetchOpenAI(system, userMsg, settings, 1500, modelOptions);
    }

    const parsed = parseNumberedTranslationsDetailed(modelResponse.text, segments, nativeLang);
    const firstCheck = validateTranslationMap(segments, parsed.result, targetLang, nativeLang, {
        truncated: modelResponse.truncated,
        duplicateIds: parsed.duplicateIds
    });
    const result = { ...firstCheck.valid };
    const invalidSegments = segments.filter(segment => firstCheck.invalid[String(segment.id)]);
    if (invalidSegments.length > 0) {
        const repairs = await translateMissingSegments(
            invalidSegments, segments, targetLang, nativeLang, settings, context, requestOptions
        );
        Object.assign(result, repairs);
    }

    const finalCheck = validateTranslationMap(segments, result, targetLang, nativeLang);
    if (Object.keys(finalCheck.invalid).length > 0) {
        throw new TranslationError('One or more subtitle lines failed translation quality checks.', {
            code: 'BLOCK_VALIDATION_FAILED',
            retryable: true,
            details: { invalid: finalCheck.invalid }
        });
    }

    requestOptions.assertCurrent?.();
    await writeTranslationCache(cacheIdentity, finalCheck.valid, requestOptions);
    return finalCheck.valid;
}



// ─── Structured Subtitle Block Translation (stable cue-id JSON) ───────────────

function extractFirstJsonObject(raw) {
    const text = String(raw || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    if (start < 0) return '';

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return '';
}

function parseStructuredTranslationJsonDetailed(raw, segments) {
    const result = {};
    const wanted = new Set((segments || []).map(s => String(s.id)));
    const seen = new Set();
    const duplicateIds = new Set();
    const unexpectedIds = new Set();
    let parseMode = 'json';

    try {
        const jsonText = extractFirstJsonObject(raw);
        const parsed = JSON.parse(jsonText || raw);
        const items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.translations || []);
        if (!Array.isArray(items)) throw new Error('Structured response has no items array.');
        for (const item of items) {
            const id = String(item.id ?? item.cue_id ?? item.cueId ?? '');
            const translation = normalizeTranslationText(item.translation ?? item.text ?? item.value ?? '');
            if (!wanted.has(id)) {
                if (id) unexpectedIds.add(id);
                continue;
            }
            if (seen.has(id)) duplicateIds.add(id);
            seen.add(id);
            if (translation) result[id] = translation;
        }
    } catch {
        parseMode = 'fallback';
        // Regex fallback for models that ignored JSON but preserved ids.
        const text = String(raw || '').replace(/<TRANSLATIONS>|<\/TRANSLATIONS>/gi, '');
        for (const segment of segments || []) {
            const id = String(segment.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?:^|\\n)\\s*\\[?${id}\\]?\\s*[:：\\]-]\\s*(.+?)(?=\\n\\s*\\[?[A-Za-z0-9_:-]+\\]?\\s*[:：\\]-]|$)`, 's');
            const m = text.match(re);
            if (m) {
                const translation = normalizeTranslationText(m[1]);
                if (translation) result[String(segment.id)] = translation;
            }
        }
    }

    for (const segment of segments || []) {
        if (!result[String(segment.id)]) result[String(segment.id)] = '';
    }
    return {
        result,
        duplicateIds: Array.from(duplicateIds),
        unexpectedIds: Array.from(unexpectedIds),
        parseMode
    };
}

function parseStructuredTranslationJson(raw, segments) {
    return parseStructuredTranslationJsonDetailed(raw, segments).result;
}

async function handleStructuredBlockTranslate(segments, targetLang, nativeLang, settings, context = [], requestOptions = {}) {
    if (!segments || !segments.length) return {};

    const stableText = JSON.stringify(segments.map(s => ({
        id: String(s.id),
        text: s.text,
        prevText: s.prevText || '',
        nextText: s.nextText || '',
        displayBreakReason: s.displayBreakReason || ''
    })));
    const cacheIdentity = createTranslationCacheIdentity(
        'structured-block', stableText, targetLang, nativeLang, settings, context, {
            videoTitle: String(settings?.translationVideoTitle || '')
        }
    );
    const cached = await readTranslationCache(cacheIdentity, requestOptions);
    if (cached) {
        const cachedCheck = validateTranslationMap(segments, cached, targetLang, nativeLang);
        if (Object.keys(cachedCheck.invalid).length === 0) return cachedCheck.valid;
    }

    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;
    const qualityRules = buildSubtitleQualityRules(nName);
    const contextBlock = buildVideoTopicBlock(settings) + buildRecentContextBlock(context);

    const payload = {
        items: segments.map(s => ({
            id: String(s.id),
            current: s.text,
            prev_source: s.prevText || '',
            next_source: s.nextText || '',
            break_reason: s.displayBreakReason || ''
        }))
    };

    const system = `You are an expert subtitle translator (${tName} to ${nName}).
Return JSON only. No markdown. No explanations.
Schema exactly: {"items":[{"id":"same id from input","translation":"translated subtitle"}]}
${qualityRules}
- Return one item for every input id, preserving the exact id string.
- Each CURRENT item is a semantic unit reconstructed from adjacent source timings, not a raw on-screen fragment.
- Treat the items in order as continuous speech. Understand the complete thought, then translate every CURRENT unit as natural, idiomatic ${nName}, not English word order.
- Reorder words and clauses freely inside CURRENT. Do not imitate the original timing cuts.
- PREV_SOURCE and NEXT_SOURCE are context hints only; use them for meaning, pronouns, and terminology without adding their facts to CURRENT.
- Do not omit concrete details or repeat meaning already carried by another semantic unit.`;

    const userMsg = `${contextBlock}\nTranslate this JSON payload:\n${JSON.stringify(payload, null, 2)}`;

    let modelResponse;
    let batchRequestError = null;
    const modelOptions = { ...requestOptions, withMetadata: true, allowTruncated: true };
    try {
        if (settings.aiProvider === 'local') {
            modelResponse = await fetchOllama(`${system}\n\n${userMsg}`, settings, 1400, modelOptions);
        } else {
            modelResponse = await fetchOpenAI(system, userMsg, settings, 1800, modelOptions);
        }
    } catch (error) {
        // Some OpenAI-compatible services accept a short single-line test but
        // reject a larger JSON response request (for example due to an output
        // limit or a provider-specific JSON restriction). Do not mark every
        // cue unavailable in that case: retry the same cues as short, ordinary
        // subtitle requests, which is the request shape already verified by
        // the connection test.
        batchRequestError = normalizeTranslationError(error);
    }

    const parsed = modelResponse
        ? parseStructuredTranslationJsonDetailed(modelResponse.text, segments)
        : { result: {}, duplicateIds: [], unexpectedIds: [] };
    const firstCheck = validateTranslationMap(segments, parsed.result, targetLang, nativeLang, {
        truncated: Boolean(modelResponse?.truncated),
        duplicateIds: parsed.duplicateIds
    });
    const result = { ...firstCheck.valid };
    const invalidSegments = segments.filter(segment => firstCheck.invalid[String(segment.id)]);
    if (invalidSegments.length > 0) {
        const repairs = await translateMissingSegments(
            invalidSegments, segments, targetLang, nativeLang, settings, context, requestOptions, result
        );
        Object.assign(result, repairs);
    }

    const finalCheck = validateTranslationMap(segments, result, targetLang, nativeLang);
    if (Object.keys(finalCheck.invalid).length > 0) {
        throw new TranslationError('One or more structured subtitle lines failed translation quality checks.', {
            code: 'STRUCTURED_BLOCK_VALIDATION_FAILED',
            retryable: true,
            details: {
                invalid: finalCheck.invalid,
                invalidSources: Object.fromEntries(
                    segments
                        .filter(segment => finalCheck.invalid[String(segment.id)])
                        .map(segment => [String(segment.id), String(segment.text || '')])
                ),
                unexpectedIds: parsed.unexpectedIds,
                batchRequestError: batchRequestError
                    ? { code: batchRequestError.code, message: batchRequestError.message }
                    : null
            }
        });
    }

    requestOptions.assertCurrent?.();
    await writeTranslationCache(cacheIdentity, finalCheck.valid, requestOptions);
    return finalCheck.valid;
}

// ─── Web Page Paragraph Translation ──────────────────────────────────────────

/**
 * Translate an array of plain-text web page paragraphs using the AI.
 * Paragraphs are grouped into batches of up to BATCH_SIZE and translated
 * with the block-translate prompt so context flows between paragraphs.
 *
 * @param {Array<{id:number, text:string}>} paragraphs
 * @param {string} targetLang  - language of the source text (usually 'en')
 * @param {string} nativeLang  - target translation language (usually 'zh')
 * @param {object} settings
 * @param {Array}  context     - recent translated pairs for continuity
 * @returns {Object} map of { id: translatedText }
 */
async function handleWebPageTranslate(paragraphs, targetLang, nativeLang, settings, context = [], requestOptions = {}) {
    if (!paragraphs || !paragraphs.length) return {};

    const BATCH_SIZE = 8;
    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;
    const result = {};

    // Process in batches
    for (let i = 0; i < paragraphs.length; i += BATCH_SIZE) {
        const batch = paragraphs.slice(i, i + BATCH_SIZE);

        const blockText = JSON.stringify(batch.map(p => ({ id: String(p.id), text: p.text })));
        const cacheIdentity = createTranslationCacheIdentity(
            'web-page-block', blockText, targetLang, nativeLang, settings, context
        );
        const cached = await readTranslationCache(cacheIdentity, requestOptions);
        if (cached) {
            const cachedCheck = validateTranslationMap(batch, cached, targetLang, nativeLang);
            if (Object.keys(cachedCheck.invalid).length === 0) {
                Object.assign(result, cachedCheck.valid);
                for (const paragraph of batch) {
                    const translated = cachedCheck.valid[String(paragraph.id)];
                    context.push({
                        original: paragraph.text.slice(0, 80),
                        translated: translated.slice(0, 80)
                    });
                    if (context.length > 6) context.shift();
                }
                continue;
            }
        }

        // Build numbered lines
        const numberedLines = batch.map(p => `[${p.id}] ${p.text}`).join('\n');
        const contextBlock = buildRecentContextBlock(context);

        const system = `You are an expert translator (${tName} to ${nName}).
Translate each numbered paragraph from a web page naturally and faithfully.
Preserve all details, lists, proper nouns, numbers, and formatting intent.
Do NOT merge or split items. Keep 1:1 mapping.
Output ONLY the translations inside <TRANSLATIONS></TRANSLATIONS> tags.
Format: one line per item, exactly like [1] 翻译内容`;

        const userMsg = `${contextBlock}\nTranslate these paragraphs:\n${numberedLines}`;

        let modelResponse;
        const modelOptions = { ...requestOptions, withMetadata: true, allowTruncated: true };
        if (settings.aiProvider === 'local') {
            modelResponse = await fetchOllama(`${system}\n\n${userMsg}`, settings, 1500, modelOptions);
        } else {
            modelResponse = await fetchOpenAI(system, userMsg, settings, 2000, modelOptions);
        }

        const parsed = parseNumberedTranslationsDetailed(modelResponse.text, batch, nativeLang);
        const firstCheck = validateTranslationMap(batch, parsed.result, targetLang, nativeLang, {
            truncated: modelResponse.truncated,
            duplicateIds: parsed.duplicateIds
        });
        const batchResult = { ...firstCheck.valid };
        const invalid = batch.filter(p => firstCheck.invalid[String(p.id)]);
        if (invalid.length > 0) {
            const fallbacks = await translateMissingSegments(
                invalid, batch, targetLang, nativeLang, settings, context, requestOptions
            );
            Object.assign(batchResult, fallbacks);
        }

        const finalCheck = validateTranslationMap(batch, batchResult, targetLang, nativeLang);
        if (Object.keys(finalCheck.invalid).length > 0) {
            throw new TranslationError('One or more web page translations failed quality checks.', {
                code: 'WEB_TRANSLATION_VALIDATION_FAILED',
                retryable: true,
                details: { invalid: finalCheck.invalid }
            });
        }

        Object.assign(result, finalCheck.valid);

        // Update context for next batch
        for (const p of batch) {
            if (finalCheck.valid[String(p.id)]) {
                context.push({
                    original: p.text.slice(0, 80),
                    translated: finalCheck.valid[String(p.id)].slice(0, 80)
                });
                if (context.length > 6) context.shift();
            }
        }

        await writeTranslationCache(cacheIdentity, finalCheck.valid, requestOptions);
    }

    return result;
}

/**
 * Parse AI output containing numbered translations like:
 *   [1] 翻译内容
 *   [2] 另一行翻译
 * Returns { 1: "翻译内容", 2: "另一行翻译" }
 */
function parseNumberedTranslationsDetailed(raw, segments, nativeLang) {
    const result = {};
    const wanted = new Set((segments || []).map(s => String(s.id)));
    const seen = new Set();
    const duplicateIds = new Set();
    const unexpectedIds = new Set();

    // Try to extract from <TRANSLATIONS> tags first
    const tagsMatch = raw.match(/<TRANSLATIONS>([\s\S]*?)<\/TRANSLATIONS>/i);
    const text = tagsMatch ? tagsMatch[1] : raw;

    const bracketPattern = /\[(\d+)\]\s*([\s\S]*?)(?=(?:\s*\[\d+\]\s*)|$)/g;
    for (const match of text.matchAll(bracketPattern)) {
        const id = parseInt(match[1], 10);
        const translation = normalizeTranslationText(match[2]);
        const idKey = String(id);
        if (!wanted.has(idKey)) {
            unexpectedIds.add(idKey);
        } else {
            if (seen.has(idKey)) duplicateIds.add(idKey);
            seen.add(idKey);
            if (translation) result[id] = translation;
        }
    }

    // Fallback: try "N." or "N)" format if [N] didn't match
    if (Object.keys(result).length === 0) {
        const lines = text.split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
            if (m) {
                const id = parseInt(m[1], 10);
                const translation = normalizeTranslationText(m[2]);
                const idKey = String(id);
                if (!wanted.has(idKey)) unexpectedIds.add(idKey);
                else {
                    if (seen.has(idKey)) duplicateIds.add(idKey);
                    seen.add(idKey);
                    if (translation) result[id] = translation;
                }
            }
        }
    }

    // Only use positional CJK fallback when the model gave us no usable numbering at all.
    if (Object.keys(result).length === 0 && ['zh', 'ja', 'ko'].includes(nativeLang)) {
        const cjkLines = text.split('\n')
            .map(l => l.replace(/^(?:\[\d+\]|\d+[.):])\s*/, '').trim())
            .filter(l => {
                const cjkChars = (l.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
                return l.length > 1 && cjkChars / l.length > 0.3;
            });

        // Assign CJK lines to segments in order only as a last resort.
        let cjkIdx = 0;
        for (const seg of segments) {
            if (cjkIdx < cjkLines.length) {
                result[seg.id] = cjkLines[cjkIdx++];
            }
        }
    }

    // Fill any remaining with empty string
    for (const seg of segments) {
        if (!result[seg.id]) result[seg.id] = '';
    }

    return {
        result,
        duplicateIds: Array.from(duplicateIds),
        unexpectedIds: Array.from(unexpectedIds)
    };
}

function parseNumberedTranslations(raw, segments, nativeLang) {
    return parseNumberedTranslationsDetailed(raw, segments, nativeLang).result;
}

async function translateMissingSegments(missingSegments, allSegments, targetLang, nativeLang, settings, context = [], requestOptions = {}, acceptedTranslations = {}) {
    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;
    const qualityRules = buildSubtitleQualityRules(nName);
    const blockLines = allSegments.map(s => `[${s.id}] ${s.text}`).join('\n');
    const contextBlock = buildVideoTopicBlock(settings) + buildRecentContextBlock(context);
    const acceptedBlock = Object.entries(acceptedTranslations || {})
        .map(([id, translation]) => `[${id}] ${translation}`)
        .join('\n');
    const result = {};

    for (const segment of missingSegments) {
        const system = `You are an expert subtitle translator (${tName} to ${nName}).
${qualityRules}
Translate ONLY the requested semantic unit. Use neighboring source and accepted translations only to keep meaning, terminology, speaker intent, and tone consistent.
Write complete, idiomatic ${nName}; freely reorder words and clauses inside the requested unit.
Output ONLY the translation text for that unit.`;

        const userMsg = `${contextBlock}
Subtitle block:
${blockLines}
${acceptedBlock ? `\nAccepted translations from this same block (terminology and tone reference only):\n${acceptedBlock}\n` : ''}

    Requested line: [${segment.id}] ${segment.text}
    ${segment.prevText ? `Previous source line: ${segment.prevText}\n` : ''}${segment.nextText ? `Next source line: ${segment.nextText}` : ''}`;

        let rawOutput;
        if (settings.aiProvider === 'local') {
            rawOutput = await fetchOllama(`${system}\n\n${userMsg}`, settings, 220, requestOptions);
        } else {
            rawOutput = await fetchOpenAI(system, userMsg, settings, 260, requestOptions);
        }

        const translation = normalizeTranslationText(extractFinalTranslation(rawOutput || '', nativeLang) || rawOutput || '');
        if (translation) {
            result[segment.id] = translation;
        }
        requestOptions.assertCurrent?.();
    }

    return result;
}

// ─── Definition ───────────────────────────────────────────────────────────────

async function handleDefinition(word, context, targetLang, nativeLang, settings) {
    const cacheKey = makeCacheKey('def', word.toLowerCase(), targetLang, nativeLang);
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;

    const system = `You are a language learning assistant. Given a ${tName} word and context, respond ONLY with JSON in this exact format (no markdown, no explanation):
{"pronunciation":"...","pos":"...","translation":"...","explanation":"..."}
Where translation and explanation are in ${nName}.`;

    const userMsg = `Word: "${word}"\nContext: "${context}"`;

    let raw;
    if (settings.aiProvider === 'local') {
        raw = await fetchOllama(`${system}\n\n${userMsg}`, settings);
    } else {
        raw = await fetchOpenAI(system, userMsg, settings);
    }

    // Extract JSON robustly
    let def;
    try {
        const match = raw.match(/\{[\s\S]*?\}/);
        def = JSON.parse(match ? match[0] : raw);
    } catch {
        def = { pronunciation: '', pos: '', translation: raw.trim(), explanation: '' };
    }

    await setCache(cacheKey, def);
    return def;
}

// ─── Fetch: OpenAI-compatible ─────────────────────────────────────────────────

async function fetchOpenAI(system, user, settings, maxTokens = 1000, requestOptions = {}) {
    if (!settings?.apiEndpoint) {
        throw new TranslationError('API endpoint is not configured.', {
            code: 'TRANSLATION_CONFIGURATION_ERROR',
            retryable: false
        });
    }
    if (!settings?.apiModel) {
        throw new TranslationError('Translation model is not configured.', {
            code: 'TRANSLATION_CONFIGURATION_ERROR',
            retryable: false
        });
    }
    // Auto-resolve endpoint: if user just gave base URL, append the right path.
    // Supports: OpenAI (/v1/chat/completions), DeepSeek (/chat/completions), etc.
    let endpoint = settings.apiEndpoint.replace(/\/+$/, ''); // strip trailing slashes
    if (!endpoint.includes('/chat/completions')) {
        // Try the most common paths
        // DeepSeek uses /chat/completions, OpenAI uses /v1/chat/completions
        if (endpoint.includes('deepseek')) {
            endpoint += '/chat/completions';
        } else {
            endpoint += '/v1/chat/completions';
        }
    }

    const init = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
            model: settings.apiModel,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
            ],
            temperature: 0.3,
            max_tokens: maxTokens
        })
    };

    const result = await requestJsonWithRetry(endpoint, init, settings,
        requestOptions.providerOverride || (settings.aiProvider === 'local' ? 'local' : 'cloud'), {
            ...requestOptions,
            validateResponse(data) {
                const choice = data?.choices?.[0];
                const rawContent = choice?.message?.content;
                const text = Array.isArray(rawContent)
                    ? rawContent.map(part => part?.text || '').join('')
                    : String(rawContent || '');
                const finishReason = choice?.finish_reason || '';
                const truncated = finishReason === 'length' || finishReason === 'max_tokens';
                if (!text.trim()) {
                    throw new TranslationError('The translation service returned an empty response.', {
                        code: 'EMPTY_TRANSLATION_RESPONSE',
                        retryable: true
                    });
                }
                if (truncated && !requestOptions.allowTruncated) {
                    throw new TranslationError('The translation response was truncated.', {
                        code: 'TRUNCATED_TRANSLATION_RESPONSE',
                        retryable: true,
                        details: { finishReason }
                    });
                }
                return { text: text.trim(), truncated, finishReason, provider: 'openai-compatible' };
            }
        });
    return requestOptions.withMetadata ? result : result.text;
}

// ─── Fetch: Ollama (/api/generate) ───────────────────────────────────────────

async function fetchOllama(prompt, settings, numPredict = 800, requestOptions = {}) {
    const endpoint = settings.localEndpoint || 'http://localhost:11434/api/generate';
    if (!settings?.localModel) {
        throw new TranslationError('Local translation model is not configured.', {
            code: 'TRANSLATION_CONFIGURATION_ERROR',
            retryable: false
        });
    }

    if (endpoint.includes('/api/generate')) {
        // Native Ollama API
        const init = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: settings.localModel,
                prompt: prompt,
                stream: false,
                keep_alive: '60m',  // keep model in GPU memory for 60 min after each use
                options: {
                    num_predict: numPredict,  // Controlled per-mode: 120 (fast) or 800 (quality)
                    num_ctx: 2048,     // small context window = fast prefill
                    temperature: 0.3
                }
            })
        };

        const result = await requestJsonWithRetry(endpoint, init, settings, 'local', {
            ...requestOptions,
            validateResponse(data) {
                const text = String(data?.response || '').trim();
                const finishReason = data?.done_reason || '';
                const truncated = finishReason === 'length' || finishReason === 'max_tokens' || data?.done === false;
                if (!text) {
                    throw new TranslationError('The local model returned an empty response.', {
                        code: 'EMPTY_TRANSLATION_RESPONSE',
                        retryable: true
                    });
                }
                if (truncated && !requestOptions.allowTruncated) {
                    throw new TranslationError('The local model response was truncated.', {
                        code: 'TRUNCATED_TRANSLATION_RESPONSE',
                        retryable: true,
                        details: { finishReason }
                    });
                }
                return { text, truncated, finishReason, provider: 'ollama' };
            }
        });
        return requestOptions.withMetadata ? result : result.text;
    }

    // Fallback: OpenAI-compatible local endpoint (LM Studio, text-gen-webui, etc.)
    return fetchOpenAI(
        'You are a helpful assistant.',
        prompt,
        {
            ...settings,
            apiEndpoint: endpoint,
            apiKey: settings.apiKey || 'local',
            apiModel: settings.localModel
        },
        numPredict,
        { ...requestOptions, providerOverride: 'local' }
    );
}

// ─── Dictionary Lookup (Dictionary API + Google Translate) ───────────────────

const NATIVE_LANG_MAP = {
    zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', es: 'es',
    fr: 'fr', de: 'de', ru: 'ru', pt: 'pt', it: 'it',
    ar: 'ar', hi: 'hi', th: 'th', vi: 'vi', tr: 'tr'
};

/**
 * Translate text(s) via Google Translate (free, no API key).
 * Accepts a single string or joins multiple texts with '\n' for batch.
 * Returns an array of translated strings.
 */
async function googleTranslateBatch(texts, nativeLang) {
    const tl = NATIVE_LANG_MAP[nativeLang] || 'zh-CN';
    const joined = Array.isArray(texts) ? texts.join('\n') : texts;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${tl}&dt=t&dj=1&q=${encodeURIComponent(joined)}`;

    try {
        const res = await fetch(url);
        if (!res.ok) return Array.isArray(texts) ? texts.map(() => '') : '';
        const data = await res.json();

        // Reassemble the translated text from sentence fragments
        const fullTranslation = (data.sentences || [])
            .map(s => s.trans || '')
            .join('')
            .trim();

        if (Array.isArray(texts)) {
            // Split back by newlines to match original array
            const parts = fullTranslation.split('\n');
            // Pad with empty strings if needed
            return texts.map((_, i) => (parts[i] || '').trim());
        }
        return fullTranslation;
    } catch {
        return Array.isArray(texts) ? texts.map(() => '') : '';
    }
}

async function handleDictLookup(word, nativeLang = 'zh') {
    if (!word) return null;

    const cleanWord = word.toLowerCase().replace(/[^a-z'-]/g, '');
    if (!cleanWord) return null;

    const cacheKey = `dict_${nativeLang}_${cleanWord}`;
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    // Step 1: Fetch English dictionary data + quick word translation in parallel
    const [dictResult, wordTransResult] = await Promise.allSettled([
        fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null),
        googleTranslateBatch(cleanWord, nativeLang)
    ]);

    // Extract phonetics, audio, and meanings from dictionaryapi.dev
    let phonetic = '', audioUrl = '', meanings = [];
    const dictData = dictResult.status === 'fulfilled' ? dictResult.value : null;
    if (Array.isArray(dictData) && dictData.length) {
        const entry = dictData[0];
        phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '';
        audioUrl = entry.phonetics?.find(p => p.audio)?.audio || '';

        meanings = (entry.meanings || []).slice(0, 4).map(m => ({
            pos: m.partOfSpeech || '',
            definitions: (m.definitions || []).slice(0, 2).map(d => ({
                def: d.definition || '',
                example: d.example || ''
            }))
        }));
    }

    // Quick translation of the word itself
    let quickTranslation = '';
    if (wordTransResult.status === 'fulfilled' && wordTransResult.value) {
        quickTranslation = typeof wordTransResult.value === 'string'
            ? wordTransResult.value
            : (wordTransResult.value[0] || '');
    }

    // Step 2: Batch-translate all English definitions to Chinese
    const allDefs = [];
    for (const m of meanings) {
        for (const d of m.definitions) {
            if (d.def) allDefs.push(d.def);
        }
    }

    if (allDefs.length > 0) {
        try {
            const translations = await googleTranslateBatch(allDefs, nativeLang);
            let idx = 0;
            for (const m of meanings) {
                for (const d of m.definitions) {
                    if (d.def) {
                        d.defTranslation = translations[idx++] || '';
                    }
                }
            }
        } catch {
            // If translation fails, definitions still show in English
        }
    }

    const result = { phonetic, audioUrl, quickTranslation, meanings };
    if (phonetic || quickTranslation || meanings.length) {
        await setCache(cacheKey, result);
    }
    return result;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function makeCacheKey(prefix, text, a, b) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    return `${prefix}_${a}_${b}_${Math.abs(h)}`;
}

function getCache(key) {
    return new Promise(resolve =>
        chrome.storage.local.get(key, r => resolve(r[key] ?? null))
    );
}

function setCache(key, value) {
    return new Promise(resolve => {
        const obj = {};
        obj[key] = value;
        chrome.storage.local.set(obj, resolve);
    });
}
