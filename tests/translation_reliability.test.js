const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function makeChromeStorage() {
    const data = {};
    const select = (keys) => {
        if (keys == null) return { ...data };
        if (typeof keys === 'string') return { [keys]: data[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, data[key]]));
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, data[key] ?? fallback]));
    };
    const area = {
        get(keys, callback) { queueMicrotask(() => callback(select(keys))); },
        set(values, callback = () => {}) {
            Object.assign(data, values);
            queueMicrotask(callback);
        },
        remove(keys, callback = () => {}) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
            queueMicrotask(callback);
        }
    };
    return { data, area };
}

function loadBackground() {
    const local = makeChromeStorage();
    const sync = makeChromeStorage();
    const listeners = {};
    let fetchImpl = async () => { throw new Error('Unexpected fetch'); };
    const chrome = {
        runtime: {
            lastError: null,
            onInstalled: { addListener(listener) { listeners.installed = listener; } },
            onMessage: { addListener(listener) { listeners.message = listener; } },
            openOptionsPage() {}
        },
        storage: {
            local: local.area,
            sync: sync.area,
            onChanged: { addListener(listener) { listeners.storageChanged = listener; } }
        },
        action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
        downloads: { download(_options, callback) { callback(1); } }
    };
    const sandbox = {
        chrome,
        console,
        URL,
        AbortController,
        TextEncoder,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        fetch(...args) { return fetchImpl(...args); }
    };
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(ROOT, 'background', 'background.js'), 'utf8');
    vm.runInContext(`${source}\n;globalThis.__translationTestHooks = {
        TranslationError,
        beginTranslationTask,
        cancelTranslationTasksForSender,
        runTranslationMessage,
        updateStoredSettings,
        createTranslationCacheIdentity,
        translationCacheKey,
        getVerifiedTranslationCache,
        setVerifiedTranslationCache,
        validateTranslationCandidate,
        validateTranslationMap,
        parseStructuredTranslationJsonDetailed,
        parseNumberedTranslationsDetailed,
        fetchOpenAI,
        fetchOllama,
        handleTranslate,
        handleBlockTranslate,
        handleStructuredBlockTranslate,
        TRANSLATION_CACHE_PREFIX,
        TRANSLATION_CACHE_INDEX_KEY,
        TRANSLATION_CACHE_MAX_ENTRIES
    };`, sandbox);
    return {
        hooks: sandbox.__translationTestHooks,
        storage: local.data,
        syncStorage: sync.data,
        listeners,
        setFetch(fn) { fetchImpl = fn; }
    };
}

function loadTranslator(sendMessage) {
    const sandbox = { chrome: { runtime: { sendMessage } }, console };
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'translator.js'), 'utf8');
    vm.runInContext(`${source}\n;globalThis.__translatorTestHooks = { TranslatorService, TranslatorRequestError };`, sandbox);
    return sandbox.__translatorTestHooks;
}

function settings(overrides = {}) {
    return {
        aiProvider: 'openai',
        apiEndpoint: 'https://api.example.test/v1/chat/completions',
        apiKey: 'test-key',
        apiModel: 'test-model',
        translationTimeoutMs: 500,
        translationMaxRetries: 0,
        translationRetryDelayMs: 0,
        ...overrides
    };
}

function fakeResponse({ status = 200, data = {}, body = '', headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
        async text() { return body; },
        async json() { return data; }
    };
}

function openAIResponse(content, finishReason = 'stop') {
    return fakeResponse({
        data: {
            choices: [{ message: { content }, finish_reason: finishReason }]
        }
    });
}

test('content bridge preserves retryable translation errors instead of returning empty success', async () => {
    const { TranslatorService } = loadTranslator(async () => ({
        success: false,
        error: 'Temporary outage',
        errorCode: 'NETWORK_ERROR',
        retryable: true
    }));

    await assert.rejects(
        TranslatorService.translateBlock([{ id: 1, text: 'Hello' }], 'en', 'zh', {}),
        error => error.code === 'NETWORK_ERROR' && error.retryable === true
    );
});

test('content bridge rejects successful-looking but incomplete block results', async () => {
    const { TranslatorService } = loadTranslator(async () => ({ success: true, result: {} }));
    await assert.rejects(
        TranslatorService.translateBlock([{ id: 1, text: 'Hello' }], 'en', 'zh', {}),
        error => error.code === 'INCOMPLETE_BLOCK_RESPONSE' && error.retryable === true
    );
});

test('fast and structured bridge methods forward task identity', async () => {
    const messages = [];
    const { TranslatorService } = loadTranslator(async message => {
        messages.push(message);
        return { success: true, result: message.action === 'translate' ? '译文' : { cue: '译文' } };
    });

    await TranslatorService.translateFast('Hello', 'en', 'zh', {}, [], { taskId: 'video-2', taskScope: 'tab-1' });
    await TranslatorService.translateStructuredBlock([{ id: 'cue', text: 'Hello' }], 'en', 'zh', {}, [], {
        taskId: 'video-2', taskScope: 'tab-1'
    });

    assert.equal(messages[0].mode, 'fast');
    assert.equal(messages[0].taskId, 'video-2');
    assert.equal(messages[1].action, 'translateStructuredBlock');
    assert.equal(messages[1].taskScope, 'tab-1');
});

test('cloud request retries a transient HTTP failure and then succeeds', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        if (calls === 1) return fakeResponse({ status: 503, body: 'busy' });
        return openAIResponse('成功');
    });

    const result = await env.hooks.fetchOpenAI('system', 'user', settings({ translationMaxRetries: 2 }), 100);
    assert.equal(result, '成功');
    assert.equal(calls, 2);
});

test('local model requests use the same bounded retry policy', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        if (calls === 1) return fakeResponse({ status: 500, body: 'loading model' });
        return fakeResponse({ data: { response: '本地成功', done: true, done_reason: 'stop' } });
    });

    const result = await env.hooks.fetchOllama('prompt', settings({
        aiProvider: 'local',
        localEndpoint: 'http://localhost:11434/api/generate',
        localModel: 'test-local',
        localTranslationTimeoutMs: 500,
        translationMaxRetries: 1
    }), 100);
    assert.equal(result, '本地成功');
    assert.equal(calls, 2);
});

test('empty model responses are retried and remain explicit failures', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        return openAIResponse('');
    });

    await assert.rejects(
        env.hooks.fetchOpenAI('system', 'user', settings({ translationMaxRetries: 1 }), 100),
        error => error.code === 'EMPTY_TRANSLATION_RESPONSE' && error.retryable === true && error.details.attempts === 2
    );
    assert.equal(calls, 2);
});

test('request timeout is bounded and retried only the configured number of times', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch((_url, init) => {
        calls++;
        return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    });

    await assert.rejects(
        env.hooks.fetchOpenAI('system', 'user', settings({
            translationTimeoutMs: 50,
            translationMaxRetries: 1
        }), 100),
        error => error.code === 'REQUEST_TIMEOUT' && error.details.attempts === 2
    );
    assert.equal(calls, 2);
});

test('a newer task generation aborts and rejects the older result as stale', async () => {
    const env = loadBackground();
    const responses = [];
    env.hooks.runTranslationMessage(
        { taskId: 'old', taskScope: 'video' }, { tab: { id: 1 } }, response => responses.push(response),
        async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
            return 'old-result';
        }
    );
    env.hooks.runTranslationMessage(
        { taskId: 'new', taskScope: 'video' }, { tab: { id: 1 } }, response => responses.push(response),
        async () => 'new-result'
    );

    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(responses.some(response => response.success && response.result === 'new-result'), true);
    const stale = responses.find(response => response.stale);
    assert.equal(stale.errorCode, 'STALE_TRANSLATION_TASK');
});

test('translation tasks are isolated by browser tab and can be cancelled by session scope', () => {
    const env = loadBackground();
    const tabOne = { tab: { id: 1 } };
    const tabTwo = { tab: { id: 2 } };
    const first = env.hooks.beginTranslationTask({ taskId: 'one', taskScope: 'youtube-subtitles' }, tabOne);
    const secondTab = env.hooks.beginTranslationTask({ taskId: 'two', taskScope: 'youtube-subtitles' }, tabTwo);

    assert.equal(first.signal.aborted, false);
    assert.equal(secondTab.signal.aborted, false);
    assert.equal(env.hooks.cancelTranslationTasksForSender(tabOne, 'youtube-subtitles'), 1);
    assert.equal(first.signal.aborted, true);
    assert.equal(secondTab.signal.aborted, false);
    secondTab.release();
});

test('settings writes are serialized in the background across callers', async () => {
    const env = loadBackground();
    await Promise.all([
        env.hooks.updateStoredSettings({ showPanel: true }),
        env.hooks.updateStoredSettings({ subtitleDisplayMode: 'translated' })
    ]);
    assert.equal(env.syncStorage.settings.showPanel, true);
    assert.equal(env.syncStorage.settings.subtitleDisplayMode, 'translated');
});

test('first install starts with working native translation defaults', async () => {
    const env = loadBackground();
    env.listeners.installed({ reason: 'install' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(env.syncStorage.settings.useAITranslation, false);
    assert.equal(env.syncStorage.settings.showPanel, false);
    assert.equal(env.syncStorage.settings.proficiencyLevel, 'middle');
    assert.equal(env.syncStorage.settings.subtitleDisplayMode, 'bilingual');
});

test('translation cache identity separates source, model and context and verifies stored source', async () => {
    const env = loadBackground();
    const baseSettings = settings();
    const a = env.hooks.createTranslationCacheIdentity('single', 'Aa', 'en', 'zh', baseSettings, [], { mode: 'fast' });
    const b = env.hooks.createTranslationCacheIdentity('single', 'BB', 'en', 'zh', baseSettings, [], { mode: 'fast' });
    const otherModel = env.hooks.createTranslationCacheIdentity('single', 'Aa', 'en', 'zh', settings({ apiModel: 'other' }), [], { mode: 'fast' });
    const otherContext = env.hooks.createTranslationCacheIdentity('single', 'Aa', 'en', 'zh', baseSettings, [
        { original: 'bank', translated: '河岸' }
    ], { mode: 'fast' });

    assert.notEqual(env.hooks.translationCacheKey(a), env.hooks.translationCacheKey(b));
    assert.notEqual(env.hooks.translationCacheKey(a), env.hooks.translationCacheKey(otherModel));
    assert.notEqual(env.hooks.translationCacheKey(a), env.hooks.translationCacheKey(otherContext));

    await env.hooks.setVerifiedTranslationCache(a, '译文');
    assert.equal(await env.hooks.getVerifiedTranslationCache(a), '译文');
    env.storage[env.hooks.translationCacheKey(a)].sourceText = 'tampered';
    assert.equal(await env.hooks.getVerifiedTranslationCache(a), null);
});

test('translation cache enforces its entry limit', async () => {
    const env = loadBackground();
    for (let i = 0; i < env.hooks.TRANSLATION_CACHE_MAX_ENTRIES + 5; i++) {
        const identity = env.hooks.createTranslationCacheIdentity(
            'single', `line-${i}`, 'en', 'zh', settings(), [], { mode: 'fast' }
        );
        await env.hooks.setVerifiedTranslationCache(identity, `translation-${i}`);
    }
    const keys = Object.keys(env.storage).filter(key => key.startsWith(env.hooks.TRANSLATION_CACHE_PREFIX));
    assert.equal(keys.length <= env.hooks.TRANSLATION_CACHE_MAX_ENTRIES, true);
});

test('structured translation repairs only the invalid or truncated line and caches the verified result', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        if (calls === 1) {
            return openAIResponse(JSON.stringify({ items: [
                { id: 'cue-1', translation: '项目 2 已准备好。' },
                { id: 'cue-2', translation: '不完整' }
            ] }), 'length');
        }
        return openAIResponse('第二行。');
    });
    const segments = [
        { id: 'cue-1', text: 'Item 2 is ready.' },
        { id: 'cue-2', text: 'Second line.' }
    ];

    const result = await env.hooks.handleStructuredBlockTranslate(segments, 'en', 'zh', settings(), []);
    assert.deepEqual({ ...result }, { 'cue-1': '项目 2 已准备好。', 'cue-2': '第二行。' });
    assert.equal(calls, 2);

    const cached = await env.hooks.handleStructuredBlockTranslate(segments, 'en', 'zh', settings(), []);
    assert.deepEqual({ ...cached }, { ...result });
    assert.equal(calls, 2);
});

test('structured subtitle translation falls back to short per-line requests when a batch is rejected', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        if (calls === 1) {
            return fakeResponse({ status: 400, body: 'batch JSON responses are not supported' });
        }
        return openAIResponse(calls === 2 ? '第一行。' : '第二行。');
    });
    const segments = [
        { id: 'cue-1', text: 'First line.' },
        { id: 'cue-2', text: 'Second line.' }
    ];

    const result = await env.hooks.handleStructuredBlockTranslate(segments, 'en', 'zh', settings(), []);
    assert.deepEqual({ ...result }, { 'cue-1': '第一行。', 'cue-2': '第二行。' });
    assert.equal(calls, 3);
});

test('common acronyms can be translated naturally without being rejected as missing tokens', () => {
    const env = loadBackground();

    const aiResult = env.hooks.validateTranslationCandidate(
        { text: 'Because the way AI connects to your tools, data,' },
        '因为人工智能会连接到你的工具和数据，',
        'en',
        'zh'
    );
    assert.equal(aiResult.valid, true);

    const apiResult = env.hooks.validateTranslationCandidate(
        { text: 'API version 42 is ready.' },
        '接口版本 42 已准备就绪。',
        'en',
        'zh'
    );
    assert.equal(apiResult.valid, true);
});

test('acronym-only and localized product subtitles remain usable', () => {
    const env = loadBackground();
    const cases = [
        ['MCP', 'MCP'],
        ['AI, API, and MCP.', 'AI、API 和 MCP。'],
        ['Use the YouTube API.', '使用油管接口。'],
        ['Connect with OpenAI.', '连接到开放人工智能。']
    ];

    for (const [source, translation] of cases) {
        const result = env.hooks.validateTranslationCandidate(
            { text: source }, translation, 'en', 'zh'
        );
        assert.equal(result.valid, true, `${source}: ${result.reasons.join(', ')}`);
    }
});

test('video subtitle blocks accept DeepSeek-style natural translation of AI', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        return openAIResponse(JSON.stringify({ items: [{
            id: 'cue-ai',
            translation: '因为人工智能会连接到你的工具和数据，'
        }] }));
    });

    const result = await env.hooks.handleStructuredBlockTranslate([{
        id: 'cue-ai',
        text: 'Because the way AI connects to your tools, data,'
    }], 'en', 'zh', settings(), []);

    assert.deepEqual({ ...result }, {
        'cue-ai': '因为人工智能会连接到你的工具和数据，'
    });
    assert.equal(calls, 1);
});

test('MCP video terminology completes as one structured subtitle block', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        return openAIResponse(JSON.stringify({ items: [
            { id: 'cue-mcp', translation: 'MCP' },
            { id: 'cue-api', translation: '使用油管接口。' },
            { id: 'cue-list', translation: 'AI、API 和 MCP。' }
        ] }));
    });

    const result = await env.hooks.handleStructuredBlockTranslate([
        { id: 'cue-mcp', text: 'MCP' },
        { id: 'cue-api', text: 'Use the YouTube API.' },
        { id: 'cue-list', text: 'AI, API, and MCP.' }
    ], 'en', 'zh', settings(), []);

    assert.deepEqual({ ...result }, {
        'cue-mcp': 'MCP',
        'cue-api': '使用油管接口。',
        'cue-list': 'AI、API 和 MCP。'
    });
    assert.equal(calls, 1);
});

test('structured subtitle requests carry natural-flow and terminology quality rules', async () => {
    const env = loadBackground();
    let requestBody;
    env.setFetch(async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return openAIResponse(JSON.stringify({ items: [
            { id: 'cue', translation: '不要删除 new-test-joe，然后按 Ctrl+Y。' }
        ] }));
    });

    await env.hooks.handleStructuredBlockTranslate([{
        id: 'cue',
        text: 'Do not delete new-test-joe, then press Ctrl+Y.'
    }], 'en', 'zh', settings({ translationVideoTitle: 'MCP vs API: Why traditional APIs are failing AI agents' }), []);

    const system = requestBody.messages[0].content;
    const user = requestBody.messages[1].content;
    assert.match(system, /speaker's intent/);
    assert.match(system, /negation/);
    assert.match(system, /commands, flags, paths, filenames/);
    assert.match(system, /continuous speech/);
    assert.match(system, /not English word order/);
    assert.match(system, /semantic unit/);
    assert.doesNotMatch(system, /1:1 ID and timing alignment/);
    assert.match(user, /Video title\/topic/);
    assert.match(user, /MCP vs API/);
});

test('single-line repair receives accepted translations from the same block', async () => {
    const env = loadBackground();
    const bodies = [];
    env.setFetch(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        if (bodies.length === 1) {
            return openAIResponse(JSON.stringify({ items: [
                { id: 'cue-1', translation: '智能体已经连接。' }
            ] }));
        }
        return openAIResponse('现在可以使用这些工具了。');
    });

    const result = await env.hooks.handleStructuredBlockTranslate([
        { id: 'cue-1', text: 'The agent is connected.' },
        { id: 'cue-2', text: 'It can use the tools now.' }
    ], 'en', 'zh', settings(), []);

    assert.equal(result['cue-2'], '现在可以使用这些工具了。');
    assert.match(bodies[1].messages[1].content, /Accepted translations from this same block/);
    assert.match(bodies[1].messages[1].content, /智能体已经连接。/);
});

test('missing product tokens stay advisory while missing numbers are rejected', () => {
    const env = loadBackground();
    const result = env.hooks.validateTranslationCandidate(
        { text: 'Use the YouTube API version 42.' },
        '请使用油管接口。',
        'en',
        'zh'
    );

    assert.equal(result.valid, false);
    assert.equal(result.warnings.includes('missing-token:YouTube'), true);
    assert.equal(result.reasons.includes('missing-number:42'), true);
});

test('a missing year is repaired before a structured translation can be cached', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        if (calls === 1) {
            return openAIResponse(JSON.stringify({ items: [{
                id: 'semantic-1',
                translation: '年年中，你仍然需要保持清醒。'
            }] }));
        }
        return openAIResponse('到了 2026 年年中，你仍然需要保持清醒。');
    });

    const segments = [{
        id: 'semantic-1',
        text: 'Halfway through 2026, you still need to stay sharp.'
    }];
    const result = await env.hooks.handleStructuredBlockTranslate(segments, 'en', 'zh', settings(), []);

    assert.equal(result['semantic-1'], '到了 2026 年年中，你仍然需要保持清醒。');
    assert.equal(calls, 2);
});

test('an unnumbered fallback translation does not mistake a leading year for a list label', () => {
    const env = loadBackground();
    const parsed = env.hooks.parseNumberedTranslationsDetailed(
        '2026 年年中，你仍然需要保持清醒。',
        [{ id: 1, text: 'Halfway through 2026, you still need to stay sharp.' }],
        'zh'
    );

    assert.equal(parsed.result[1], '2026 年年中，你仍然需要保持清醒。');
});

test('legacy numbered block interface remains compatible and returns a complete verified map', async () => {
    const env = loadBackground();
    env.setFetch(async () => openAIResponse('<TRANSLATIONS>\n[1] 第一行。\n[2] 第二行。\n</TRANSLATIONS>'));
    const segments = [
        { id: 1, text: 'First line.' },
        { id: 2, text: 'Second line.' }
    ];

    const result = await env.hooks.handleBlockTranslate(segments, 'en', 'zh', settings(), []);
    assert.deepEqual({ ...result }, { 1: '第一行。', 2: '第二行。' });
});

test('source text repeated after repair fails explicitly and is never cached', async () => {
    const env = loadBackground();
    let calls = 0;
    env.setFetch(async () => {
        calls++;
        if (calls === 1) {
            return openAIResponse(JSON.stringify({ items: [
                { id: 'cue', translation: 'This sentence must be translated.' }
            ] }));
        }
        return openAIResponse('This sentence must be translated.');
    });
    const segments = [{ id: 'cue', text: 'This sentence must be translated.' }];

    await assert.rejects(
        env.hooks.handleStructuredBlockTranslate(segments, 'en', 'zh', settings(), []),
        error => error.code === 'STRUCTURED_BLOCK_VALIDATION_FAILED' && error.retryable === true
    );
    const cacheKeys = Object.keys(env.storage).filter(key => key.startsWith(env.hooks.TRANSLATION_CACHE_PREFIX));
    assert.equal(cacheKeys.length, 0);
});
