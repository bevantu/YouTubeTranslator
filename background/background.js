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
                        proficiencyLevel: 'intermediate',
                        aiProvider: 'local',
                        apiKey: '',
                        apiEndpoint: 'https://api.openai.com/v1/chat/completions',
                        apiModel: 'gpt-4o-mini',
                        localEndpoint: 'http://localhost:11434/api/generate',
                        localModel: 'qwen2.5:14b',
                        showPanel: true,
                        fontSize: 16,
                        knownWordColor: '#4CAF50',
                        unknownWordColor: '#FF9800',
                        autoTranslate: true,
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
    if (message.action === 'translate') {
        handleTranslate(
            message.text, message.targetLang, message.nativeLang,
            message.settings, message.context || [], false, message.mode || 'quality'
        )
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
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
                k.startsWith('tr_') || k.startsWith('def_') || k.startsWith('dict_')
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
        handleTranslate('太棒了，成功了', 'en', 'zh', s, [], true, 'fast')
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'openOptions') {
        chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
    }

    return true;
});

// ─── Translation ──────────────────────────────────────────────────────────────

async function handleTranslate(text, targetLang, nativeLang, settings, context = [], skipCache = false, mode = 'quality') {
    if (!text || !text.trim()) return '';

    const cacheKey = makeCacheKey('tr', text, targetLang, nativeLang);
    if (!skipCache) {
        const cached = await getCache(cacheKey);
        if (cached) return cached;
    }

    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;

    // Build context block from recent subtitles
    let contextBlock = '';
    if (context && context.length > 0) {
        const lines = context
            .slice(-5)
            .map(c => `  [${c.original}] → [${c.translated}]`)
            .join('\n');
        contextBlock = `\n\nRecent subtitles (do NOT retranslate):\n${lines}\n`;
    }

    let system, userMsg, translation;

    if (mode === 'fast') {
        // ── Fast mode ────────────────────────────────────────────────────
        // For real-time fallback when subtitle is already on screen.
        // Single-pass, minimal prompt, strict token cap.
        system = `Translate ${tName} subtitle to natural spoken ${nName}. Output ONLY the translation.`;
        userMsg = `${contextBlock}\n${text}`;

        if (settings.aiProvider === 'local') {
            translation = await fetchOllama(`${system}\n\n${userMsg}`, settings, 120);
        } else {
            translation = await fetchOpenAI(system, userMsg, settings, 200);
        }
    } else {
        // ── Quality mode (default) ────────────────────────────────────────
        // Used during pre-translation where we have plenty of time.
        // Translate-Reflect-Refine for natural, contextual output.
        system = `You are an expert subtitle translator (${tName} to ${nName}).
Use the Translate-Reflect-Refine workflow:
1. Initial Translation: translate accurately and colloquially.
2. Reflection: critique the flow, tone, and conciseness.
3. Refined Translation: produce the final polished subtitle.

CRITICAL RULES:
- Natural spoken ${nName}, NOT word-for-word.
- Output the TRANSLATION ONLY inside <FINAL></FINAL> tags. No line breaks in the translation.
- Keep the translation on a single line. Do NOT insert \\n or line breaks in the final output.`;
        userMsg = `${contextBlock}\nTranslate this subtitle:\n${text}`;

        if (settings.aiProvider === 'local') {
            translation = await fetchOllama(`${system}\n\n${userMsg}`, settings, 800);
        } else {
            translation = await fetchOpenAI(system, userMsg, settings, 1000);
        }

        // Extract from <FINAL> tags
        const match = (translation || '').match(/<FINAL>([\s\S]*?)<\/FINAL>/i);
        if (match) translation = match[1];
    }

    // Strip accidental quotes, whitespace, and any newlines
    translation = (translation || '')
        .trim()
        .replace(/\\n/g, ' ')    // literal backslash-n from LLM
        .replace(/[\r\n]+/g, ' ') // actual newlines
        .replace(/\s{2,}/g, ' ') // collapse multiple spaces
        .replace(/^["「『]|["」』]$/g, '')
        .trim();

    if (translation) await setCache(cacheKey, translation);
    return translation;
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

async function fetchOpenAI(system, user, settings, maxTokens = 1000) {
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

    const res = await fetch(endpoint, {
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
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`API Error ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
}

// ─── Fetch: Ollama (/api/generate) ───────────────────────────────────────────

async function fetchOllama(prompt, settings, numPredict = 800) {
    const endpoint = settings.localEndpoint || 'http://localhost:11434/api/generate';

    if (endpoint.includes('/api/generate')) {
        // Native Ollama API
        const res = await fetch(endpoint, {
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
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Ollama Error ${res.status}: ${body.slice(0, 300)}`);
        }

        const data = await res.json();
        return (data.response || '').trim();
    }

    // Fallback: OpenAI-compatible local endpoint (LM Studio, text-gen-webui, etc.)
    return fetchOpenAI(
        'You are a helpful assistant.',
        prompt,
        { ...settings, apiEndpoint: endpoint, apiKey: settings.apiKey || 'local' }
    );
}

// ─── Dictionary Lookup (Free APIs, parallel) ─────────────────────────────────

const NATIVE_LANG_MAP = {
    zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', es: 'es',
    fr: 'fr', de: 'de', ru: 'ru', pt: 'pt', it: 'it',
    ar: 'ar', hi: 'hi', th: 'th', vi: 'vi', tr: 'tr'
};

async function handleDictLookup(word, nativeLang = 'zh') {
    if (!word) return null;

    const cleanWord = word.toLowerCase().replace(/[^a-z'-]/g, '');
    if (!cleanWord) return null;

    const cacheKey = `dict_${nativeLang}_${cleanWord}`;
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    // Run BOTH lookups in parallel for speed
    const [dictResult, transResult] = await Promise.allSettled([
        // 1. English phonetics & definitions from dictionaryapi.dev
        fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null),
        // 2. Quick translation via MyMemory (free, no key needed)
        fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanWord)}&langpair=en|${NATIVE_LANG_MAP[nativeLang] || 'zh-CN'}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
    ]);

    // Extract phonetics & audio from dictionaryapi.dev
    let phonetic = '', audioUrl = '';
    const dictData = dictResult.status === 'fulfilled' ? dictResult.value : null;
    if (Array.isArray(dictData) && dictData.length) {
        const entry = dictData[0];
        phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '';
        audioUrl = entry.phonetics?.find(p => p.audio)?.audio || '';
    }

    // Extract translation from MyMemory
    let quickTranslation = '';
    const transData = transResult.status === 'fulfilled' ? transResult.value : null;
    if (transData?.responseStatus === 200 && transData?.responseData?.translatedText) {
        quickTranslation = transData.responseData.translatedText;
    }

    const result = { phonetic, audioUrl, quickTranslation };
    if (phonetic || quickTranslation) {
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
