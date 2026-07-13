const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const optimizerSource = fs.readFileSync(
    path.join(__dirname, '..', 'content', 'subtitleOptimizer.js'),
    'utf8'
);
const panelSource = fs.readFileSync(
    path.join(__dirname, '..', 'content', 'panel.js'),
    'utf8'
);

function createPanelHarness() {
    const context = { document: {}, console, Map, Set };
    vm.createContext(context);
    vm.runInContext(`${panelSource}\n;globalThis.__panel = SubtitlePanel;`, context, { filename: 'panel.js' });
    const panel = context.__panel;
    panel.renderVirtualWindow = () => {};
    return panel;
}

function createHarness(translatorOverrides = {}) {
    const dispatched = [];
    const renders = [];
    const warnings = [];
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
        title: 'Test Video - YouTube',
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
        console: { log() {}, warn(...args) { warnings.push(args); }, error() {} },
        setTimeout,
        clearTimeout,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {}
    };
    vm.createContext(context);
    vm.runInContext(optimizerSource, context, { filename: 'subtitleOptimizer.js' });
    return { manager, core: context.YBSubtitleOptimizerCore, dispatched, renders, warnings, video };
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

test('discarded translation tasks do not produce a playback warning or retry state', async () => {
    const staleError = Object.assign(new Error('Discarded a stale translation result.'), {
        code: 'STALE_TRANSLATION_TASK',
        retryable: false,
        stale: true
    });
    const { manager, warnings, video } = createHarness({
        translateStructuredBlock: async () => { throw staleError; }
    });
    manager.settings.autoTranslate = true;
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    manager._setupCaptions(manager.parseJSON3(json3([[0, 1000, 'Old subtitle line']])), {
        lang: 'en', videoId: 'old-video'
    });
    clearTimeout(manager.warmupTimerId);
    manager.warmupTimerId = null;
    video.currentTime = 0.2;

    manager.onTimeUpdate(video.currentTime);
    await new Promise(resolve => setTimeout(resolve, 0));
    clearTimeout(manager.priorityTimerId);
    manager.priorityTimerId = null;

    assert.equal(warnings.length, 0);
    assert.equal(manager.translationBlocks[0].failureCount || 0, 0);
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

test('translation blocks bridge lowercase and dangling continuations across caption gaps', () => {
    const { core } = createHarness();
    const cues = [
        { id: 'a', startMs: 0, endMs: 1000, text: 'I want to add a login screen to', sourceLanguage: 'en' },
        { id: 'b', startMs: 1700, endMs: 2600, text: 'my website.', sourceLanguage: 'en' },
        { id: 'c', startMs: 4000, endMs: 5000, text: 'No, actually, why', sourceLanguage: 'en' },
        { id: 'd', startMs: 5600, endMs: 6500, text: "don't you continue first?", sourceLanguage: 'en' }
    ];

    const blocks = core.buildTranslationBlocks(cues, 1);
    assert.equal(blocks.length, 2);
    assert.deepEqual(
        JSON.parse(JSON.stringify(Array.from(blocks, block => block.cues.map(cue => cue.id)))),
        [['a', 'b'], ['c', 'd']]
    );
});

test('semantic translation units ignore raw cue cuts and keep leading years intact', () => {
    const { core } = createHarness();
    const cues = [
        { id: 'a', startMs: 0, endMs: 1500, text: 'The problem might just be with you. So, at the moment, the', sourceLanguage: 'en' },
        { id: 'b', startMs: 1500, endMs: 2600, text: 'way that things are halfway through', sourceLanguage: 'en' },
        { id: 'c', startMs: 2600, endMs: 3800, text: '2026, you still need to be smart. You', sourceLanguage: 'en' },
        { id: 'd', startMs: 3800, endMs: 5200, text: 'still need to be a good engineer to get really good results out of using AI.', sourceLanguage: 'en' }
    ];

    const plan = core.buildSemanticTranslationPlan(cues, 'en');
    assert.deepEqual(Array.from(plan.segments, segment => segment.text), [
        'The problem might just be with you.',
        'So, at the moment, the way that things are halfway through 2026, you still need to be smart.',
        'You still need to be a good engineer to get really good results out of using AI.'
    ]);
    assert.deepEqual(Array.from(plan.cueToSegmentIds.b), ['semantic_2']);
    assert.deepEqual(Array.from(plan.cueToSegmentIds.c), ['semantic_2', 'semantic_3']);
    assert.equal(core.normalizeTranslationForDisplay('2026 年年中，你仍需保持清醒。'), '2026 年年中，你仍需保持清醒。');
    assert.equal(core.normalizeTranslationForDisplay('[1] 第一条译文。'), '第一条译文。');
});

test('semantic translations are displayed once instead of repeated on every overlapping cue', async () => {
    let requestedSegments = [];
    let requestCount = 0;
    const translations = {
        semantic_1: '第一部分，宏观视角。',
        semantic_2: '我们将从这本书的核心思想开始。',
        semantic_3: 'AI 工程将基础模型转化为可用于生产的系统。'
    };
    const { manager } = createHarness({
        translateStructuredBlock: async segments => {
            requestCount++;
            requestedSegments = segments;
            return Object.fromEntries(segments.map(segment => [segment.id, translations[segment.id]]));
        }
    });
    manager.settings.autoTranslate = true;
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    manager._setupCaptions(manager.parseJSON3(json3([
        [0, 1500, "Section one, the big picture. We're"],
        [1500, 1100, 'going to start with the big idea of the'],
        [2600, 1200, 'book. AI engineering turns foundation'],
        [3800, 1400, 'models into production-ready systems.']
    ])), { lang: 'en', videoId: 'no-repeat-flow' });
    clearTimeout(manager.warmupTimerId);
    manager.warmupTimerId = null;

    await manager._translateBlock(manager.translationBlocks[0].id);

    assert.deepEqual(Array.from(requestedSegments, segment => segment.text), [
        'Section one, the big picture.',
        "We're going to start with the big idea of the book.",
        'AI engineering turns foundation models into production-ready systems.'
    ]);
    assert.equal(manager.captions[0].translation, translations.semantic_1);
    assert.equal(manager.captions[1].translation, translations.semantic_2);
    assert.equal(manager.captions.filter(cue => cue.translation.includes(translations.semantic_2)).length, 1);
    assert.equal(manager.captions[2].translation.includes(translations.semantic_2), false);
    assert.equal(manager.captions[2].translation, 'AI 工程将基础模型');
    assert.equal(manager.captions[3].translation, '转化为可用于生产的系统。');
    assert.equal(
        (manager.captions[2].translation + manager.captions[3].translation).replace(/\s/g, ''),
        translations.semantic_3.replace(/\s/g, '')
    );

    await manager._translateBlock(manager.translationBlocks[0].id);
    assert.equal(requestCount, 1);
});

test('a short sentence uses one owner cue while covered cues stay resolved holds', async () => {
    let requestCount = 0;
    const { manager, core, video, renders } = createHarness({
        translateStructuredBlock: async segments => {
            requestCount++;
            return Object.fromEntries(segments.map(segment => [segment.id, '是的。']));
        }
    });
    manager.settings.autoTranslate = true;
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    manager._setupCaptions(manager.parseJSON3(json3([
        [0, 900, 'Yes'],
        [900, 900, 'that is'],
        [1800, 900, 'correct.']
    ])), { lang: 'en', videoId: 'short-owner' });
    clearTimeout(manager.warmupTimerId);
    manager.warmupTimerId = null;

    await manager._translateBlock(manager.translationBlocks[0].id);

    assert.equal(manager.captions.filter(cue => cue.translation === '是的。').length, 1);
    assert.equal(manager.captions.filter(cue => cue.translationMode === 'hold').length, 2);
    assert.equal(manager.translationBlocks.every(block => block.cues.every(core.cueTranslationResolved)), true);

    const ownerIndex = manager.captions.findIndex(cue => cue.translation === '是的。');
    if (ownerIndex < manager.captions.length - 1) {
        video.currentTime = manager.captions[ownerIndex + 1].startMs / 1000 + 0.01;
        manager.onTimeUpdate(video.currentTime);
        assert.equal(renders.at(-1).translation, '是的。');
        assert.equal(renders.at(-1).loading, false);
    }

    await manager._translateBlock(manager.translationBlocks[0].id);
    assert.equal(requestCount, 1);
});

test('the side panel treats a hold as ready without copying the previous translation', () => {
    const panel = createPanelHarness();
    const caption = panel.normalizeCaption({
        index: 0,
        id: 'hold-cue',
        startMs: 1000,
        endMs: 2000,
        text: 'covered source words',
        translation: '',
        translationMode: 'hold',
        status: 'ready'
    }, 0);
    panel.captions = [caption];
    panel.indexToPosition = new Map([[0, 0]]);

    panel.updateSubtitleTranslation(0, '', 'ready', '', 'hold');

    assert.equal(panel.captions[0].translation, '');
    assert.equal(panel.captions[0].translationMode, 'hold');
    assert.equal(panel.captions[0].status, 'ready');
});

test('long Chinese translations split at natural pauses without breaking numbers or units', () => {
    const { core } = createHarness();
    const translation = '到了 2026 年年中，通胀降至 2.4%，但利率仍然很高。';
    const chunks = core.splitNaturalTranslation(translation, [1, 1, 1], 'zh');

    assert.deepEqual(Array.from(chunks), [
        '到了 2026 年年中，',
        '通胀降至 2.4%，',
        '但利率仍然很高。'
    ]);
    assert.equal(chunks.join(''), translation);
});

test('rolling captions assign weight only to newly revealed source words', () => {
    const { manager, core } = createHarness();
    manager._ybParsingMeta = { lang: 'en', kind: 'asr' };
    const cues = manager.parseJSON3(json3([
        [0, 1200, 'I'],
        [800, 1200, 'I like'],
        [1600, 1200, 'I like apples.']
    ]));
    const plan = core.buildSemanticTranslationPlan(cues, 'en');

    assert.deepEqual(
        Object.values(plan.segments[0].cueTokenWeights),
        [1, 1, 1]
    );
});

test('semantic regrouping covers technology, daily life, finance, and interviews', () => {
    const { core } = createHarness();
    const cases = [
        ['The model calls the', 'API, then returns JSON.'],
        ['When you get home, put', 'your phone away.'],
        ['Inflation fell to', '2.4% while rates stayed high.'],
        ['What surprised you the', 'most about that decision?']
    ];

    for (const fragments of cases) {
        const cues = fragments.map((text, index) => ({
            id: `cue-${index}`,
            startMs: index * 1000,
            endMs: index * 1000 + 900,
            text,
            sourceLanguage: 'en'
        }));
        const plan = core.buildSemanticTranslationPlan(cues, 'en');
        assert.equal(plan.segments.length, 1, fragments.join(' / '));
        assert.equal(plan.segments[0].text, fragments.join(' '));
    }
});

test('translation context is ordered by subtitle time and never includes future blocks', async () => {
    const requests = [];
    const { manager } = createHarness({
        translateStructuredBlock: async (segments, _source, _native, requestSettings, context) => {
            requests.push({
                text: segments.map(segment => segment.text).join(' '),
                title: requestSettings.translationVideoTitle,
                context: JSON.parse(JSON.stringify(context))
            });
            return Object.fromEntries(segments.map(segment => [segment.id, `译：${segment.text}`]));
        }
    });
    manager.settings.autoTranslate = true;
    manager._ybParsingMeta = { lang: 'en', kind: '' };
    manager._setupCaptions(manager.parseJSON3(json3([
        [0, 900, 'First topic.'],
        [2000, 900, 'Middle topic.'],
        [4000, 900, 'Future topic.']
    ])), { lang: 'en', videoId: 'ordered-context' });
    clearTimeout(manager.warmupTimerId);
    manager.warmupTimerId = null;

    await manager._translateBlock(manager.translationBlocks[2].id);
    await manager._translateBlock(manager.translationBlocks[0].id);
    await manager._translateBlock(manager.translationBlocks[1].id);

    const earlier = requests.find(request => request.text === 'First topic.');
    const middle = requests.find(request => request.text === 'Middle topic.');
    assert.deepEqual(earlier.context, []);
    assert.equal(earlier.title, 'Test Video');
    assert.deepEqual(middle.context.map(item => item.original), ['First topic.']);
    assert.equal(middle.context.some(item => item.original === 'Future topic.'), false);
});
