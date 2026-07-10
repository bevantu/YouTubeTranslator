const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const optimizerSource = fs.readFileSync(
    path.join(__dirname, '..', 'content', 'subtitleOptimizer.js'),
    'utf8'
);

function createHarness(translatorOverrides = {}) {
    const dispatched = [];
    const renders = [];
    const video = { currentTime: 0, addEventListener() {}, removeEventListener() {} };
    class TestCustomEvent {
        constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    }

    const manager = {
        settings: {
            targetLanguage: 'en', nativeLanguage: 'zh', autoTranslate: false,
            useAITranslation: true, aiProvider: 'openai'
        },
        captions: [],
        translationBlocks: [],
        pendingBlockTranslations: new Map(),
        contextBuffer: [],
        translationAbortKey: 0,
        currentCaptionFingerprint: '',
        subtitleContainer: { innerHTML: '' },
        startsWithContinuationWord: () => false,
        canBreakDisplaySegment: () => true,
        extractTimedTextMeta: () => ({}),
        buildCaptionFingerprint(entries, meta) {
            return [meta?.lang || '', entries.length, entries[0]?.startMs, entries.at(-1)?.endMs].join('|');
        },
        hideNativeCaptions() {},
        logDebug() {},
        renderSubtitle(text, translation, loading) { renders.push({ text, translation, loading }); },
        getBlockEntries(blockId) { return this.captions.filter(c => c.translateBlockId === blockId); },
        markBlockPending(blockId) {
            this.getBlockEntries(blockId).forEach(c => { if (c.translation == null) c.translation = '__pending__'; });
        },
        clearBlockPending(blockId, fallback = null) {
            this.getBlockEntries(blockId).forEach(c => { if (c.translation === '__pending__') c.translation = fallback; });
        },
        async updateSettings(settings) { this.settings = settings; },
        destroy() { this.captions = []; this.translationBlocks = []; },
        createSubtitleContainer() {},
        attachTimeupdateListener() {}
    };

    const document = {
        dispatchEvent(event) { dispatched.push(event); return true; },
        querySelector(selector) { return selector === 'video' ? video : null; }
    };
    const context = {
        SubtitleManager: manager,
        TranslatorService: {
            translateStructuredBlock: async () => ({}),
            translateBlock: async () => ({}),
            translate: async () => '',
            ...translatorOverrides
        },
        document,
        CustomEvent: TestCustomEvent,
        window: { location: { origin: 'https://www.youtube.com' } },
        location: { href: 'https://www.youtube.com/watch?v=test-video' },
        URL,
        Intl,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {}
    };
    vm.createContext(context);
    vm.runInContext(optimizerSource, context, { filename: 'subtitleOptimizer.js' });
    return { manager, core: context.YBSubtitleOptimizerCore, dispatched, renders, video };
}

function json3(events) {
    return { events: events.map(([start, duration, text]) => ({
        tStartMs: start,
        dDurationMs: duration,
        segs: [{ utf8: text }]
    })) };
}

test('human caption cues preserve their original timing, including overlap', () => {
    const { manager } = createHarness();
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    const cues = manager.parseJSON3(json3([
        [0, 5000, 'First human cue'],
        [3000, 2000, 'Second human cue']
    ]));
    assert.deepEqual(Array.from(cues, c => [c.startMs, c.endMs]), [[0, 5000], [3000, 5000]]);
});

test('continuous playback advances to the newest active overlapping human cue', () => {
    const { manager } = createHarness();
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    manager.captions = manager.parseJSON3(json3([
        [0, 5000, 'First human cue'],
        [3000, 2000, 'Second human cue']
    ]));
    manager.currentCaptionIndex = 0;

    assert.equal(manager.findCurrentCaptionIndex(2500), 0);
    assert.equal(manager.findCurrentCaptionIndex(3200), 1);
});

test('English rolling captions never expose words before their event time', () => {
    const { manager } = createHarness();
    manager._ybParsingMeta = { lang: 'en', kind: 'asr' };
    const cues = manager.parseJSON3(json3([
        [0, 1500, 'I'],
        [1000, 1500, 'I like'],
        [2000, 1500, 'I like apples']
    ]));
    assert.equal(cues.find(c => c.startMs === 0).text, 'I');
    assert.equal(cues.find(c => c.startMs === 1000).text, 'I like');
    assert.equal(cues.find(c => c.startMs === 2000).text, 'I like apples');
});

test('Chinese rolling captions deduplicate without inserting spaces', () => {
    const { manager } = createHarness();
    manager._ybParsingMeta = { lang: 'zh', kind: 'asr' };
    const cues = manager.parseJSON3(json3([
        [0, 1200, '今天'],
        [800, 1200, '今天天气'],
        [1600, 1200, '今天天气很好']
    ]));
    assert.deepEqual(Array.from(cues, c => c.text), ['今天', '今天天气', '今天天气很好']);
    assert.ok(cues.every(c => !c.text.includes(' ')));
});

test('Thai uses no-space overlap while Korean keeps word spaces', () => {
    const { core } = createHarness();
    assert.equal(core.extractNewText('ฉันชอบ', 'ฉันชอบแมว', 'th'), 'แมว');
    assert.equal(core.joinTokens(['나는', '고양이를 좋아해'], 'ko'), '나는 고양이를 좋아해');
});

test('long silence has no active caption', () => {
    const { manager } = createHarness();
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    manager.captions = manager.parseJSON3(json3([
        [0, 1000, 'Before pause'],
        [10000, 1000, 'After pause']
    ]));
    manager.currentCaptionIndex = -1;
    assert.equal(manager.findCurrentCaptionIndex(5000), -1);
});

test('native translation alignment tolerates small timestamp drift', () => {
    const { manager } = createHarness();
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    const cues = manager.parseJSON3(
        json3([[1000, 1000, 'Hello world']]),
        json3([[1120, 1000, '你好，世界']])
    );
    assert.equal(cues[0].translation, '你好，世界');
});

test('same text at different times rerenders and emits generation-aware events', () => {
    const { manager, dispatched, renders } = createHarness();
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    const cues = manager.parseJSON3(json3([
        [0, 1000, 'Again'],
        [2000, 1000, 'Again']
    ]));
    manager._setupCaptions(cues, { lang: 'en' });
    const generation = manager._ybGeneration;
    manager.onTimeUpdate(0.2);
    manager.onTimeUpdate(2.2);

    assert.equal(renders.length, 2);
    const ready = dispatched.find(e => e.type === 'yb-captions-ready');
    const active = dispatched.filter(e => e.type === 'yb-caption-active' && e.detail.index >= 0);
    assert.equal(ready.detail.generation, generation);
    assert.deepEqual(active.map(e => e.detail.index), [0, 1]);
    assert.ok(active.every(e => e.detail.generation === generation));
});

test('a result from an invalidated generation cannot write into current captions', async () => {
    let finishTranslation;
    const pending = new Promise(resolve => { finishTranslation = resolve; });
    const { manager } = createHarness({ translateStructuredBlock: () => pending });
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    const cues = manager.parseJSON3(json3([[0, 1000, 'Old video text']]));
    manager._setupCaptions(cues, { lang: 'en', videoId: 'old' });
    manager.settings.autoTranslate = true;
    const oldBlock = manager.translationBlocks[0];
    const work = manager._translateBlock(oldBlock.id);

    await manager.updateSettings({ ...manager.settings, nativeLanguage: 'ja' });
    finishTranslation({ [oldBlock.cues[0].id]: '过期译文' });
    await work;

    assert.equal(manager.captions[0].translation, null);
    assert.notEqual(manager.translationBlocks[0], oldBlock);
});

test('a nearby block reports pending and becomes ready even before its first cue starts', async () => {
    const { manager, dispatched, video } = createHarness({
        translateStructuredBlock: async segments => Object.fromEntries(
            segments.map(segment => [segment.id, `translated-${segment.id}`])
        )
    });
    manager.settings.autoTranslate = true;
    manager.settings.useAITranslation = true;
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    const cues = manager.parseJSON3(json3([[3000, 1200, 'First spoken line']]));
    manager._setupCaptions(cues, { lang: 'en', videoId: 'intro' });
    clearTimeout(manager.warmupTimerId);
    manager.warmupTimerId = null;
    video.currentTime = 0;

    await manager._translateBlock(manager.translationBlocks[0].id);

    const translationEvents = dispatched.filter(event => event.type === 'yb-caption-translation');
    const statusEvents = dispatched.filter(event => event.type === 'yb-subtitle-status');
    assert.equal(translationEvents.some(event => event.detail.status === 'pending'), true);
    assert.equal(translationEvents.some(event => event.detail.status === 'ready'), true);
    assert.equal(statusEvents.at(-1).detail.state, 'ready');
});
