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
        handleTranslate(message.text, message.targetLang, message.nativeLang, message.settings, message.context || [])
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
        handleTranslate('太棒了，成功了', 'en', 'zh', s, true)
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

async function handleTranslate(text, targetLang, nativeLang, settings, context = [], skipCache = false) {
    if (!text || !text.trim()) return '';

    const cacheKey = makeCacheKey('tr', text, targetLang, nativeLang);
    if (!skipCache) {
        const cached = await getCache(cacheKey);
        if (cached) return cached;
    }

    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;

    // ── Build high-quality subtitle translation prompt ─────────────────────────
    //
    // Key principles:
    //  1. This is SPOKEN language — match colloquial register, not formal text
    //  2. Aim for idiomatic target-language phrasing, not word-for-word
    //  3. Include recent subtitle context so the model understands the topic
    //  4. Keep translations concise enough to read quickly as subtitles
    //
    const system = `You are an expert subtitle translator. Your task is to translate ${tName} spoken subtitles into natural, fluent ${nName}.

Core rules:
- This is SPOKEN language from a video — sound natural and conversational, not like a textbook
- NEVER translate word-for-word; convey the true meaning and intent naturally
- Match the speaker's register: casual → colloquial ${nName}; technical → clear technical ${nName}; humorous → preserve the humor
- Keep the translation concise — subtitles must be easy to read at a glance
- Handle incomplete sentences, filler words (um, uh, well, so), and spoken quirks gracefully
- Output ONLY the translated subtitle text, with no explanation, no quotes, no extra punctuation`;

    // Build context block from recent subtitles
    let contextBlock = '';
    if (context && context.length > 0) {
        const lines = context
            .slice(-5)
            .map(c => `  [${c.original}] → [${c.translated}]`)
            .join('\n');
        contextBlock = `\n\nRecent subtitles for context (do NOT translate these again):\n${lines}\n`;
    }

    const userMsg = `${contextBlock}\nTranslate this subtitle:\n${text}`;

    let translation;
    if (settings.aiProvider === 'local') {
        const fullPrompt = `${system}\n\n${userMsg}`;
        translation = await fetchOllama(fullPrompt, settings);
    } else {
        translation = await fetchOpenAI(system, userMsg, settings);
    }

    // Strip any accidental quotes the model might add
    translation = (translation || '')
        .trim()
        .replace(/^["「『]|["」』]$/g, '');

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

async function fetchOpenAI(system, user, settings) {
    const res = await fetch(settings.apiEndpoint, {
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
            max_tokens: 500
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

async function fetchOllama(prompt, settings) {
    const endpoint = settings.localEndpoint || 'http://localhost:11434/api/generate';

    if (endpoint.includes('/api/generate')) {
        // Native Ollama API
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: settings.localModel,
                prompt: prompt,
                stream: false
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
