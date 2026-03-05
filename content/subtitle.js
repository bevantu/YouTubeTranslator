/**
 * Subtitle Manager — timedtext-based approach
 *
 * Instead of watching DOM mutations (which causes word-dripping because
 * YouTube reveals auto-generated captions word-by-word via CSS animations),
 * we intercept YouTube's timedtext API response (captured by inject.js in
 * the page context), build a full caption timeline, and show subtitles
 * based on video.currentTime via the timeupdate event.
 *
 * Flow:
 *  inject.js (MAIN world)
 *    ↳ intercepts fetch/XHR for timedtext URL
 *    ↳ fires CustomEvent('__yb_timedtext__') on window
 *  content.js
 *    ↳ listens for __yb_timedtext__ → SubtitleManager.loadTimedText()
 *  SubtitleManager
 *    ↳ parses JSON3 / XML captions into CaptionEntry[]
 *    ↳ hides YouTube's own caption layer
 *    ↳ on video timeupdate → finds current entry → renders bilingual line
 *    ↳ translation request goes to Background SW via TranslatorService
 */
const SubtitleManager = {
    subtitleContainer: null,
    settings: null,
    vocabulary: {},

    /** @type {{ startMs: number, endMs: number, text: string, translation: string|null }[]} */
    captions: [],

    lastRenderedText: '',
    translationAbortKey: 0,
    timeupdateHandler: null,
    contextBuffer: [],   // last 8 translated subtitles for context window
    logBuffer: new Map(), // map of context -> {timeMs, translated}
    preTranslating: false,

    // ── Init ──────────────────────────────────────────────────────────────────

    async init(settings) {
        this.settings = settings;
        this.vocabulary = await StorageHelper.getVocabulary();
        this.createSubtitleContainer();
        this.attachTimeupdateListener();

        document.addEventListener('yb-vocabulary-updated', async () => {
            this.vocabulary = await StorageHelper.getVocabulary();
        });
    },

    // ── Subtitle container ────────────────────────────────────────────────────

    createSubtitleContainer() {
        if (document.getElementById('yt-bilingual-subtitles')) {
            this.subtitleContainer = document.getElementById('yt-bilingual-subtitles');
            return;
        }
        this.subtitleContainer = document.createElement('div');
        this.subtitleContainer.id = 'yt-bilingual-subtitles';
        this.subtitleContainer.className = 'yb-subtitle-container';

        const tryInsert = () => {
            const player = document.querySelector('#movie_player');
            if (player) { player.appendChild(this.subtitleContainer); return true; }
            return false;
        };
        if (!tryInsert()) {
            const iv = setInterval(() => { if (tryInsert()) clearInterval(iv); }, 300);
        }
    },

    // ── Timedtext ingestion ───────────────────────────────────────────────────

    /**
     * Called by content.js when inject.js fires the __yb_timedtext__ event.
     * @param {string} rawText  - Raw response body (JSON or XML string)
     * @param {string} url      - Original request URL (used to detect format)
     */
    async loadTimedText(rawText, url) {
        let isJson3 = (url && url.includes('fmt=json3')) || (rawText.startsWith('{') && rawText.includes('events'));
        if (!isJson3) {
            // Fallback: XML timedtext format
            const entries = this.parseXML(rawText);
            if (entries.length) this._setupCaptions(entries);
            return;
        }

        let json = null;
        try { json = JSON.parse(rawText); } catch { return; }

        let baseJson = json;
        let transJson = null;

        // If AI Translation is disabled, we fetch the native YouTube translation track directly.
        if (this.settings.autoTranslate && !this.settings.useAITranslation && url) {
            try {
                let tlang = this.settings.nativeLanguage;
                if (tlang === 'zh') tlang = 'zh-Hans';

                const parsedUrl = new URL(url.startsWith('/') ? window.location.origin + url : url);
                if (parsedUrl.searchParams.has('tlang')) {
                    // The intercepted one IS the translation. Fetch the original.
                    transJson = json;
                    const origUrl = new URL(parsedUrl);
                    origUrl.searchParams.delete('tlang');
                    const res = await fetch(origUrl.toString());
                    baseJson = await res.json();
                } else {
                    // The intercepted one is the original. Fetch the translation.
                    baseJson = json;
                    const transUrl = new URL(parsedUrl);
                    transUrl.searchParams.set('tlang', tlang);
                    const res = await fetch(transUrl.toString());
                    transJson = await res.json();
                }
            } catch (err) {
                console.warn('[YT Bilingual] Failed to fetch native translation track:', err);
                baseJson = json;
                transJson = null;
            }
        }

        const entries = this.parseJSON3(baseJson, transJson);
        if (entries.length) this._setupCaptions(entries);
    },

    _setupCaptions(entries) {
        console.log(`[YT Bilingual] Loaded ${entries.length} caption entries`);
        // Cancel any previous pre-translation run
        this.preTranslating = false;
        this.captions = entries;
        this.lastRenderedText = '';
        this.translationAbortKey++;
        this.contextBuffer = [];

        // Hide YouTube's own caption layer
        this.hideNativeCaptions(true);

        // Start background AI pre-translation with warmup phase
        if (this.settings.autoTranslate && this.settings.useAITranslation) {
            setTimeout(() => this.warmupAndTranslate(), 500);
        }
    },

    /**
     * Phase 1: Pause video, pre-translate the first WARMUP_COUNT subtitles,
     * show progress overlay, then resume and continue pre-translating the rest.
     * This ensures ALL displayed subtitles are high-quality (TRR).
     */
    async warmupAndTranslate() {
        const WARMUP_COUNT = 8;
        const video = document.querySelector('video');
        const wasPlaying = video && !video.paused;

        if (video && !video.paused) {
            video.pause();
        }

        this.showWarmupOverlay(0, Math.min(WARMUP_COUNT, this.captions.length));

        this.preTranslating = true;
        let translated = 0;
        const total = Math.min(WARMUP_COUNT, this.captions.length);

        const BATCH_SIZE = 3;
        let i = 0;
        while (i < total && this.preTranslating) {
            const batch = [];
            while (batch.length < BATCH_SIZE && i < total) {
                const entry = this.captions[i];
                if (entry.translation === null) {
                    for (const sibling of this.captions) {
                        if (sibling.translateContext === entry.translateContext && sibling.translation === null) {
                            sibling.translation = '__pending__';
                        }
                    }
                    batch.push(entry);
                }
                i++;
            }
            if (!batch.length) continue;

            const ctx = this.contextBuffer.slice(-3);
            await Promise.allSettled(batch.map(async (entry) => {
                let resolvedCount = 0;
                try {
                    await this._translateBlock(entry.translateContext, ctx);
                    for (const sibling of this.captions) {
                        if (sibling.translateContext === entry.translateContext && sibling.startMs <= this.captions[total - 1].endMs) {
                            resolvedCount++;
                        }
                    }
                } catch (err) {
                    console.warn('[YT Bilingual] Warmup translate failed:', err.message);
                    for (const s of this.captions) {
                        if (s.translateContext === entry.translateContext && s.translation === '__pending__') {
                            s.translation = '';
                        }
                    }
                }
                translated += resolvedCount || 1;
                this.showWarmupOverlay(Math.min(translated, total), total);
            }));
        }

        this.hideWarmupOverlay();
        if (wasPlaying && video) {
            video.play();
        }

        console.log(`[YT Bilingual] Warmup complete (${translated}/${total}), resuming playback`);
        this.startPreTranslation(total);
    },

    /**
     * Show a small overlay indicating warmup progress.
     */
    showWarmupOverlay(done, total) {
        let overlay = document.getElementById('yb-warmup-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'yb-warmup-overlay';
            overlay.style.cssText = `
                position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
                z-index: 99998; background: rgba(15, 15, 20, 0.95);
                backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                padding: 12px 24px; border-radius: 12px;
                border: 1px solid rgba(99, 102, 241, 0.3);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(99, 102, 241, 0.1);
                font-family: 'Inter', 'Segoe UI', sans-serif; color: #f0f0f5;
                font-size: 14px; display: flex; align-items: center; gap: 12px;
                animation: yb-fadeIn 0.3s ease;
            `;
            document.body.appendChild(overlay);
        }
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        overlay.innerHTML = `
            <div style="width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.1);
                border-top-color: #6366f1; border-radius: 50%;
                animation: yb-spin 0.8s linear infinite;"></div>
            <span>Preparing translations... <strong>${done}/${total}</strong></span>
            <div style="width: 80px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                <div style="width: ${pct}%; height: 100%; background: linear-gradient(90deg, #6366f1, #818cf8);
                    border-radius: 2px; transition: width 0.3s ease;"></div>
            </div>
        `;
    },

    hideWarmupOverlay() {
        const overlay = document.getElementById('yb-warmup-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity 0.3s ease';
            setTimeout(() => overlay.remove(), 300);
        }
    },

    /**
     * Pre-translate remaining subtitles in the background with CONCURRENCY.
     * Uses 'quality' mode (Translate-Reflect-Refine) since we have time.
     * @param {number} startFrom - Index to start from (after warmup)
     */
    async startPreTranslation(startFrom = 0) {
        this.preTranslating = true;
        console.log(`[YT Bilingual] Background pre-translation from index ${startFrom}`);
        const BATCH_SIZE = 3;

        let i = startFrom;
        while (i < this.captions.length && this.preTranslating) {
            const batch = [];
            while (batch.length < BATCH_SIZE && i < this.captions.length) {
                const entry = this.captions[i];
                if (entry.translation === null) {
                    // Lock all siblings in the same block
                    for (const sibling of this.captions) {
                        if (sibling.translateContext === entry.translateContext && sibling.translation === null) {
                            sibling.translation = '__pending__';
                        }
                    }
                    batch.push(entry);
                }
                i++;
            }
            if (!batch.length) continue;

            const ctx = this.contextBuffer.slice(-3);
            await Promise.allSettled(batch.map(async (entry) => {
                try {
                    await this._translateBlock(entry.translateContext, ctx);

                    // Re-render current if it was updated
                    const current = this.captions.find(c => c.text === this.lastRenderedText && c.translateContext === entry.translateContext);
                    if (current && current.translation && current.translation !== '__pending__') {
                        this.renderSubtitle(current.text, current.translation, false);
                    }
                } catch (err) {
                    console.warn('[YT Bilingual] Pre-translate failed:', err.message);
                    for (const s of this.captions) {
                        if (s.translateContext === entry.translateContext && s.translation === '__pending__') {
                            s.translation = '';
                        }
                    }
                }
            }));

            await new Promise(r => setTimeout(r, 10));
        }
        this.preTranslating = false;
        console.log('[YT Bilingual] Pre-translation complete');
    },

    /**
     * Parse YouTube JSON3 caption format.
     * Optionally takes the translated Json body and perfectly aligns it.
     */
    parseJSON3(json, transJson = null) {
        // Map translations by startMs
        const transMap = new Map();
        if (transJson && transJson.events) {
            for (const ev of transJson.events) {
                if (ev.tStartMs != null && ev.segs) {
                    const text = ev.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim();
                    transMap.set(ev.tStartMs, text);
                }
            }
        }

        // Step 1: collect events with exact YouTube timestamps
        const raw = [];
        for (const ev of json.events) {
            if (!ev.segs || !ev.dDurationMs) continue;
            const text = ev.segs
                .map(s => (s.utf8 || '').replace(/\n/g, ' '))
                .join('').trim();
            if (!text) continue;
            raw.push({
                startMs: ev.tStartMs,
                endMs: ev.tStartMs + ev.dDurationMs,
                text,
                translation: transMap.get(ev.tStartMs) || null,
                translateContext: ''
            });
        }
        if (!raw.length) return [];
        raw.sort((a, b) => a.startMs - b.startMs);

        // Step 2: dedup by startMs
        const byStart = new Map();
        for (const e of raw) {
            const ex = byStart.get(e.startMs);
            if (!ex || e.text.length > ex.text.length) byStart.set(e.startMs, e);
        }
        const events = Array.from(byStart.values()).sort((a, b) => a.startMs - b.startMs);

        // Step 3: Strict overlap truncation
        for (let i = 0; i < events.length - 1; i++) {
            if (events[i].endMs > events[i + 1].startMs) {
                events[i].endMs = events[i + 1].startMs;
            }
        }

        // Step 4: Deduplicate rolling window — extract new words and translations
        const atoms = [];
        let prevFullText = '';
        let prevTransText = '';
        for (const ev of events) {
            const evWords = ev.text.split(/\s+/).filter(Boolean);
            const prevWords = prevFullText.split(/\s+/).filter(Boolean);

            let overlapLen = 0;
            for (let len = Math.min(prevWords.length, evWords.length); len > 0; len--) {
                if (prevWords.slice(-len).join(' ').toLowerCase() === evWords.slice(0, len).join(' ').toLowerCase()) {
                    overlapLen = len;
                    break;
                }
            }

            const newWords = overlapLen > 0 ? evWords.slice(overlapLen) : evWords;

            // Trans deduplication (string overlap works better for CJK without spaces)
            let evTrans = ev.translation || '';
            let newTrans = evTrans;
            if (newTrans && prevTransText && newTrans.startsWith(prevTransText)) {
                newTrans = newTrans.slice(prevTransText.length).trim();
            } else if (newTrans) {
                let maxOver = Math.min(prevTransText.length, newTrans.length);
                let over = 0;
                for (let j = maxOver; j > 0; j--) {
                    if (prevTransText.endsWith(newTrans.slice(0, j))) {
                        over = j;
                        break;
                    }
                }
                if (over > 0) newTrans = newTrans.slice(over).trim();
            }

            if (newWords.length > 0) {
                atoms.push({
                    startMs: ev.startMs,
                    endMs: ev.endMs,
                    newText: newWords.join(' '),
                    newTrans: newTrans
                });
            }
            prevFullText = ev.text;
            if (evTrans) prevTransText = evTrans;
        }

        // Step 5: Merge atoms into longer sentence-like segments (~40-80 chars)
        const MIN_SEGMENT_CHARS = 35;
        const TARGET_SEGMENT_CHARS = 60;
        const MAX_SEGMENT_CHARS = 90;
        const merged = [];
        let segText = '';
        let segTrans = '';
        let segStart = 0;
        let segEnd = 0;

        for (let i = 0; i < atoms.length; i++) {
            const atom = atoms[i];
            const gap = segText ? (atom.startMs - segEnd) : 0;

            let shouldBreak = false;
            if (segText) {
                if (gap > 600) shouldBreak = true;
                const trimmed = segText.trim();
                if (trimmed.match(/[.!?。！？]$/) && !trimmed.match(/\b(Mr|Mrs|Ms|Dr|Vs)\.$/i) && segText.length >= MIN_SEGMENT_CHARS) {
                    shouldBreak = true;
                }
                if ((segText + ' ' + atom.newText).length > MAX_SEGMENT_CHARS && segText.length >= MIN_SEGMENT_CHARS) {
                    shouldBreak = true;
                }
            }

            if (shouldBreak && segText) {
                merged.push({
                    startMs: segStart,
                    endMs: segEnd,
                    text: segText.trim(),
                    translation: segTrans.trim() || null,
                    translateContext: ''
                });
                segText = '';
                segTrans = '';
            }

            if (!segText) {
                segStart = atom.startMs;
                segText = atom.newText;
                segTrans = atom.newTrans;
            } else {
                segText += ' ' + atom.newText;
                segTrans += (segTrans && atom.newTrans ? ' ' : '') + atom.newTrans;
            }
            segEnd = atom.endMs;

            if (segText.length >= TARGET_SEGMENT_CHARS) {
                const trimmed = segText.trim();
                if (trimmed.match(/[,;:，；：]$/) || trimmed.match(/[.!?。！？]$/)) {
                    merged.push({
                        startMs: segStart,
                        endMs: segEnd,
                        text: trimmed,
                        translation: segTrans.trim() || null,
                        translateContext: ''
                    });
                    segText = '';
                    segTrans = '';
                }
            }
        }
        if (segText.trim()) {
            merged.push({
                startMs: segStart,
                endMs: segEnd,
                text: segText.trim(),
                translation: segTrans.trim() || null,
                translateContext: ''
            });
        }

        // Step 6: Fix endMs so consecutive segments don't leave gaps
        for (let i = 0; i < merged.length - 1; i++) {
            if (merged[i].endMs < merged[i + 1].startMs) {
                // Extend to cover the gap (the segment should stay on screen until the next one)
                merged[i].endMs = merged[i + 1].startMs;
            }
        }

        // Step 7: Group merged segments into context blocks for translation.
        // We group consecutive segments and build the full sentence context
        // to send to the LLM for better translation quality.
        let currentBlock = [];
        const blocks = [];

        for (let i = 0; i < merged.length; i++) {
            const curr = merged[i];
            let newBlock = false;

            if (currentBlock.length > 0) {
                const prev = currentBlock[currentBlock.length - 1];
                const gap = curr.startMs - prev.endMs;
                const prevText = prev.text.trim();
                const endedSentence = prevText.match(/[.!?。！？]$/) && !prevText.match(/\b(Mr|Mrs|Ms|Dr|Vs)\.$/i);

                // Start new block on gap or sentence boundary
                if (gap > 600 || endedSentence) {
                    newBlock = true;
                }
                // Also break if block is getting very long (prevent sending huge context to LLM)
                const blockText = currentBlock.map(s => s.text).join(' ') + ' ' + curr.text;
                if (blockText.length > 300) {
                    newBlock = true;
                }
            }

            if (newBlock) {
                blocks.push(currentBlock);
                currentBlock = [];
            }
            currentBlock.push(curr);
        }
        if (currentBlock.length > 0) blocks.push(currentBlock);

        // Assign translateContext for each block
        for (const block of blocks) {
            const blockText = block.map(s => s.text).join(' ');
            for (const seg of block) {
                seg.translateContext = blockText;
            }
        }

        console.log(`[YT Bilingual] merged: ${events.length} raw events → ${merged.length} display segments in ${blocks.length} context blocks.`);
        return merged;
    },


    /** Parse legacy XML timedtext format */
    parseXML(xml) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, 'text/xml');
            const sentences = Array.from(doc.querySelectorAll('text')).map(el => {
                const start = parseFloat(el.getAttribute('start') || '0') * 1000;
                const dur = parseFloat(el.getAttribute('dur') || '2') * 1000;
                const text = el.textContent.trim();
                return {
                    startMs: start,
                    endMs: start + dur,
                    text: text,
                    translation: null,
                    translateContext: text
                };
            }).filter(e => e.text);

            // Fix Overlaps: Strict truncation preventing current subtitle from bleeding into next
            for (let s = 0; s < sentences.length - 1; s++) {
                if (sentences[s].endMs > sentences[s + 1].startMs) {
                    sentences[s].endMs = sentences[s + 1].startMs;
                }
            }
            return sentences;
        } catch {
            return [];
        }
    },

    // ── Time Tracking (60fps synced) ──────────────────────────────────────────

    attachTimeupdateListener() {
        const attach = () => {
            const video = document.querySelector('video');
            if (!video) { setTimeout(attach, 500); return; }

            // Clean up any existing loop
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
            }

            // High-fidelity tracking via requestAnimationFrame (~16ms precision)
            // Much better than 'timeupdate' event which only fires every ~250ms
            const loop = () => {
                if (!this.subtitleContainer) return; // Stop if destroyed
                this.onTimeUpdate(video.currentTime);
                this.rafId = requestAnimationFrame(loop);
            };
            this.rafId = requestAnimationFrame(loop);
        };
        attach();
    },

    onTimeUpdate(currentTimeSec) {
        if (!this.captions.length) return;

        const ms = currentTimeSec * 1000;
        // Find the caption whose window contains current time
        const entry = this.captions.find(c => ms >= c.startMs && ms < c.endMs);

        if (!entry) {
            // Between captions — clear display
            if (this.lastRenderedText !== '') {
                this.lastRenderedText = '';
                if (this.subtitleContainer) this.subtitleContainer.innerHTML = '';
            }
            return;
        }

        if (entry.text === this.lastRenderedText) return; // already showing this
        this.lastRenderedText = entry.text;

        // Determine loading state
        const needsTranslation = this.settings.autoTranslate && this.settings.useAITranslation && entry.translation === null;
        // Show immediately with full original text
        this.renderSubtitle(entry.text, entry.translation, needsTranslation);

        // Request translation only once per entry.
        // Use '__pending__' sentinel to prevent duplicate in-flight requests.
        if (needsTranslation) {
            // Lock ALL siblings so they don't trigger duplicate parallel requests
            for (const sibling of this.captions) {
                if (sibling.translateContext === entry.translateContext && sibling.translation === null) {
                    sibling.translation = '__pending__';
                }
            }

            const recentContext = this.contextBuffer.slice(-5);
            this._translateBlock(entry.translateContext, recentContext).then(() => {
                // Re-render current segment with its translation
                const current = this.captions.find(c => c.text === this.lastRenderedText && c.translateContext === entry.translateContext);
                if (current && current.translation && current.translation !== '__pending__') {
                    this.renderSubtitle(current.text, current.translation, false);
                }
            }).catch(err => {
                console.error('[YT Bilingual] Translation error:', err);
                for (const s of this.captions) {
                    if (s.translateContext === entry.translateContext && s.translation === '__pending__') {
                        s.translation = '';
                    }
                }
            });
        }
    },

    // ── Render ────────────────────────────────────────────────────────────────

    renderSubtitle(original, translation, loading) {
        if (!this.subtitleContainer) return;
        const settings = this.settings;
        const container = this.subtitleContainer;
        container.innerHTML = '';

        // Click background → pause/play
        container.onclick = (e) => {
            if (e.target.classList.contains('yb-word')) return;
            const v = document.querySelector('video');
            if (v) v.paused ? v.play() : v.pause();
        };

        // Original line with word highlighting
        if (settings.showOriginalSubtitle) {
            const line = document.createElement('div');
            line.className = 'yb-subtitle-line yb-subtitle-original';
            line.style.fontSize = `${settings.fontSize}px`;

            const tokens = tokenizeText(original, settings.targetLanguage);
            tokens.forEach((token, idx) => {
                // Determine if this token is punctuation (not a word)
                const isPunctuation = !isWord(token);

                // Add space BEFORE this token if:
                // 1. Not the first token
                // 2. Not a CJK language (CJK doesn't use spaces)
                // 3. Current token is NOT punctuation (punctuation attaches to previous word)
                if (idx > 0 && !['zh', 'ja', 'ko'].includes(settings.targetLanguage) && !isPunctuation) {
                    line.appendChild(document.createTextNode(' '));
                }

                if (!isPunctuation) {
                    const span = document.createElement('span');
                    span.className = 'yb-word';
                    span.textContent = token;

                    const lToken = token.toLowerCase();
                    const key = `${settings.targetLanguage}:${lToken}`;
                    const entry = this.vocabulary[key];

                    let isKnown = false;
                    let isLearning = false;

                    if (entry) {
                        isKnown = entry.status === 'known';
                        isLearning = entry.status === 'learning';
                    } else if (settings.targetLanguage === 'en' && settings.proficiencyLevel && settings.proficiencyLevel !== 'none' && window.WordLevels) {
                        // Strip leading/trailing non-alpha chars (e.g. >>It → it)
                        let checkToken = lToken.replace(/^[^a-z]+|[^a-z]+$/g, '');

                        // Extract stem from contraction:
                        //   doesn't → does (strip n't), it's → it (strip 's), i'm → i
                        let stemForLookup = checkToken;
                        if (stemForLookup.endsWith("n't")) {
                            stemForLookup = stemForLookup.slice(0, -3);
                            const negMap = {
                                doesn: 'does', isn: 'is', aren: 'are', wasn: 'was',
                                weren: 'were', haven: 'have', hasn: 'has', hadn: 'had',
                                won: 'will', can: 'can', couldn: 'could', shouldn: 'should',
                                wouldn: 'would', didn: 'did', don: 'do'
                            };
                            stemForLookup = negMap[stemForLookup] || stemForLookup;
                        } else {
                            for (const suf of ["'ve", "'re", "'ll", "'m", "'d", "'s"]) {
                                if (stemForLookup.endsWith(suf)) {
                                    stemForLookup = stemForLookup.slice(0, -suf.length);
                                    break;
                                }
                            }
                        }

                        const ALWAYS_KNOWN = new Set([
                            "i", "a", "an", "the", "to", "and", "of", "in", "is", "it",
                            "you", "that", "he", "she", "we", "they", "me", "him", "her",
                            "us", "them", "my", "your", "his", "our", "their", "its",
                            "be", "do", "go", "on", "at", "by", "as", "up", "or", "if",
                            "no", "so", "was", "are", "has", "had", "not", "but", "for",
                            "can", "did", "got", "get", "let", "say", "see", "use",
                            "does", "have", "from", "this", "with", "will", "been", "were"
                        ]);

                        if (!stemForLookup || ALWAYS_KNOWN.has(stemForLookup) || ALWAYS_KNOWN.has(checkToken)) {
                            isKnown = true;
                        } else {
                            const lvl = settings.proficiencyLevel;
                            const WL = window.WordLevels;

                            const inPrimary = WL.primary.includes(stemForLookup) || WL.primary.includes(checkToken);
                            const inMiddle = inPrimary || WL.middle.includes(stemForLookup) || WL.middle.includes(checkToken);
                            const inHigh = inMiddle || WL.high.includes(stemForLookup) || WL.high.includes(checkToken);
                            const inCet4 = inHigh || WL.cet4.includes(stemForLookup) || WL.cet4.includes(checkToken);
                            const inCet6 = inCet4 || WL.cet6.includes(stemForLookup) || WL.cet6.includes(checkToken);

                            if (lvl === 'primary' && inPrimary) isKnown = true;
                            else if (lvl === 'middle' && inMiddle) isKnown = true;
                            else if (lvl === 'high' && inHigh) isKnown = true;
                            else if (lvl === 'cet4' && inCet4) isKnown = true;
                            else if (lvl === 'cet6' && inCet6) isKnown = true;
                        }
                    }

                    if (isKnown) {
                        span.classList.add('yb-word-known');
                    } else if (isLearning) {
                        span.classList.add('yb-word-learning');
                    } else {
                        span.classList.add('yb-word-unknown');
                    }

                    span.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const v = document.querySelector('video');
                        if (v && !v.paused) v.pause();
                        WordPopup.show(span, token, original,
                            settings.targetLanguage, settings.nativeLanguage, settings);
                    });

                    line.appendChild(span);
                } else {
                    // Punctuation: no space before, just append the text
                    line.appendChild(document.createTextNode(token));
                }
            });

            container.appendChild(line);
        }

        // Translation line
        if (settings.showTranslatedSubtitle) {
            const tLine = document.createElement('div');
            tLine.className = 'yb-subtitle-line yb-subtitle-translation';
            tLine.style.fontSize = `${Math.max(12, settings.fontSize - 2)}px`;

            if (loading || translation === '__pending__') {
                tLine.innerHTML = '<span class="yb-translating">⋯</span>';
            } else if (translation) {
                tLine.textContent = translation;
            }
            // Always append (even empty, to hold layout space)
            container.appendChild(tLine);
        }
    },

    // ── Helpers ───────────────────────────────────────────────────────────────

    hideNativeCaptions(hide) {
        const cw = document.querySelector('.ytp-caption-window-container');
        if (cw) {
            cw.style.opacity = hide ? '0' : '';
            cw.style.pointerEvents = hide ? 'none' : '';
        }
    },

    async updateSettings(newSettings) {
        this.settings = newSettings;
        this.vocabulary = await StorageHelper.getVocabulary();
    },

    destroy() {
        this.preTranslating = false; // cancel any ongoing pre-translation loop
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.subtitleContainer) this.subtitleContainer.remove();
        this.subtitleContainer = null;
        this.captions = [];
        this.lastRenderedText = '';
        this.contextBuffer = [];
        this.logBuffer.clear();
        this.hideNativeCaptions(false);
    },

    // ── Block Translation (AI-aligned) ─────────────────────────────────────────

    /**
     * Translate all siblings of a context block using numbered segment approach.
     * AI sees each segment as a numbered line and returns per-segment translations.
     * This guarantees perfect Chinese-English alignment.
     */
    async _translateBlock(translateContext, context) {
        const siblings = this.captions.filter(c => c.translateContext === translateContext);
        if (!siblings.length) return;

        // Build numbered segments for the AI
        const segments = siblings.map((s, idx) => ({
            id: idx + 1,
            text: s.text
        }));

        const result = await TranslatorService.translateBlock(
            segments,
            this.settings.targetLanguage,
            this.settings.nativeLanguage,
            this.settings,
            context
        );

        // Assign translations by ID
        let anyTranslated = false;
        for (let idx = 0; idx < siblings.length; idx++) {
            const id = idx + 1;
            const trans = result[id] || '';
            siblings[idx].translation = trans;
            if (trans) anyTranslated = true;
        }

        // Update context buffer and log
        if (anyTranslated) {
            const fullOriginal = siblings.map(s => s.text).join(' ');
            const fullTranslated = siblings.map(s => s.translation || '').join('');
            this.addToLog(fullOriginal, fullTranslated, siblings[0].startMs);
            this.contextBuffer.push({ original: fullOriginal, translated: fullTranslated });
            if (this.contextBuffer.length > 8) this.contextBuffer.shift();
        }
    },

    // ── Translation Splitting (fallback) ──────────────────────────────────────

    /**
     * Split a block translation proportionally among all display segments
     * that share the same translateContext, so each segment shows only
     * its corresponding portion of the Chinese (or other native language)
     * translation instead of the entire block.
     *
     * Uses WORD COUNT (not character count) for proportions, because
     * English words and Chinese characters have far more comparable
     * information density than English characters vs Chinese characters.
     * e.g. "frustrates" (10 chars, 1 word) ≈ "沮丧" (2 chars, 1 concept)
     */
    assignBlockTranslation(translateContext, fullTranslation) {
        const siblings = this.captions.filter(c => c.translateContext === translateContext);

        // Only one segment or empty translation — assign directly
        if (siblings.length <= 1 || !fullTranslation) {
            for (const s of siblings) s.translation = fullTranslation;
            return;
        }

        const trans = fullTranslation;
        const transLen = trans.length;

        // Count words in each segment (English: split by spaces; CJK: each char ≈ 1 word)
        const wordCounts = siblings.map(s => {
            const words = s.text.split(/\s+/).filter(Boolean);
            return words.length;
        });
        const totalWords = wordCounts.reduce((sum, c) => sum + c, 0);

        // First pass: try to split at sentence-ending punctuation in translation.
        // Count sentence-ending markers in both original and translation.
        const origSentenceEnds = [];
        let runningWords = 0;
        for (let i = 0; i < siblings.length - 1; i++) {
            runningWords += wordCounts[i];
            const segText = siblings[i].text.trim();
            // Check if this segment ends with sentence-ending punctuation
            const endsSentence = /[.!?。！？]$/.test(segText) && !/\b(Mr|Mrs|Ms|Dr|Vs)\.$/i.test(segText);
            origSentenceEnds.push({
                index: i,
                wordRatio: runningWords / totalWords,
                endsSentence
            });
        }

        // Find sentence-ending punctuation positions in translation
        const transSentenceEnds = [];
        for (let j = 0; j < transLen; j++) {
            if (/[。？！.!?]/.test(trans[j])) {
                transSentenceEnds.push(j + 1); // position AFTER the punctuation
            }
        }

        // Try to align sentence boundaries between original and translation
        let usedChars = 0;
        const breakPoints = []; // break positions in translation text

        for (const info of origSentenceEnds) {
            const targetEnd = Math.round(usedChars + (info.wordRatio * transLen) - usedChars);
            const absoluteTarget = Math.round(info.wordRatio * transLen);

            if (info.endsSentence && transSentenceEnds.length > 0) {
                // Find the closest sentence-end in translation near the expected position
                let bestSentEnd = -1;
                let bestDist = Infinity;
                for (const sePos of transSentenceEnds) {
                    if (sePos <= usedChars) continue;
                    if (sePos >= transLen) continue;
                    const dist = Math.abs(sePos - absoluteTarget);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestSentEnd = sePos;
                    }
                }
                // Accept if within reasonable range (40% of translation length)
                if (bestSentEnd > 0 && bestDist < transLen * 0.4) {
                    breakPoints.push(bestSentEnd);
                    usedChars = bestSentEnd;
                    continue;
                }
            }

            // Fallback: use word-count ratio with natural break search
            let targetPos = Math.round(info.wordRatio * transLen);
            targetPos = Math.max(usedChars + 1, Math.min(targetPos, transLen - 1));
            targetPos = this.findNaturalBreak(trans, targetPos, usedChars, transLen);
            breakPoints.push(targetPos);
            usedChars = targetPos;
        }

        // Apply the splits
        let start = 0;
        for (let i = 0; i < siblings.length; i++) {
            if (i === siblings.length - 1) {
                siblings[i].translation = trans.slice(start).trim();
            } else {
                const end = breakPoints[i];
                siblings[i].translation = trans.slice(start, end).trim();
                start = end;
            }
        }
    },

    /**
     * Find a natural break point in translation text near the target position.
     * Prefers breaking after Chinese/English punctuation, with priority given
     * to stronger punctuation (sentence-ending > clause-level > other).
     */
    findNaturalBreak(text, target, minPos, maxPos) {
        const SEARCH_RANGE = 20;

        // Priority levels for break characters (lower = better)
        const breakPriority = (ch) => {
            if (/[。？！.!?]/.test(ch)) return 1;  // Sentence-ending
            if (/[；;]/.test(ch)) return 2;          // Semicolons
            if (/[，,]/.test(ch)) return 3;          // Commas
            if (/[、：:]/.test(ch)) return 4;        // Other punctuation
            if (/\s/.test(ch)) return 5;             // Whitespace
            return 99;
        };

        let bestPos = target;
        let bestScore = Infinity; // Lower is better: priority * 100 + distance

        for (let d = 0; d <= SEARCH_RANGE; d++) {
            for (const offset of [d, -d]) {
                const pos = target + offset;
                if (pos <= minPos || pos >= maxPos) continue;

                const ch = text[pos - 1]; // Check char BEFORE the break position
                const pri = breakPriority(ch);
                if (pri < 99) {
                    const score = pri * 100 + d;
                    if (score < bestScore) {
                        bestScore = score;
                        bestPos = pos;
                    }
                }
            }
            // Stop early if we found a sentence-end nearby
            if (bestScore < 200) break;
        }
        return bestPos;
    },

    // ── Log Persistence ────────────────────────────────────────────────────────

    addToLog(original, translated, startTimeMs) {
        if (!this.settings?.enableLogging || !translated) return;
        if (this.logBuffer.has(original)) return;
        this.logBuffer.set(original, { time: startTimeMs, translated });
    },

    downloadLog() {
        if (!this.logBuffer.size) return;

        const entries = Array.from(this.logBuffer.entries()).map(([original, val]) => ({
            original,
            translated: val.translated,
            time: val.time
        }));
        entries.sort((a, b) => a.time - b.time);

        const title = document.title.replace(/ - YouTube$/, '') || 'Video Log';
        const header = `Video: ${title}\nURL: ${window.location.href}\nGenerated at: ${new Date().toLocaleString()}\n` + "=".repeat(60) + "\n\n";

        const logText = header + entries.map(item => {
            const m = Math.floor(item.time / 60000);
            const s = Math.floor((item.time % 60000) / 1000);
            const timeStr = `[${m}:${s.toString().padStart(2, '0')}]`;
            return `${timeStr} ${item.original}\n[${this.settings.nativeLanguage.toUpperCase()}] ${item.translated}\n`;
        }).join('\n');

        chrome.runtime.sendMessage({
            action: 'downloadLog',
            filename: title,
            content: logText
        }, (res) => {
            if (res?.success) console.log('[YT Bilingual] Log saved successfully');
            else console.error('[YT Bilingual] Failed to save log:', res?.error);
        });
    }
};
