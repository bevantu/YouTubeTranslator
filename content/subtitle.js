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

    /** @type {{ startMs: number, endMs: number, text: string, sentIdx: number }[]} */
    captions: [],

    /** @type {{ text: string, translation: string|null, segmentIndices: number[] }[]} */
    sentences: [],

    lastRenderedText: '',
    translationAbortKey: 0,
    timeupdateHandler: null,
    contextBuffer: [],   // last 8 translated subtitles for context window
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
    loadTimedText(rawText, url) {
        let result = null;
        try {
            // YouTube JSON3 format (most common for modern captions)
            const json = JSON.parse(rawText);
            if (json.events) {
                result = this.parseJSON3(json);
            }
        } catch {
            // Fallback: XML timedtext format
            const segments = this.parseXML(rawText);
            if (segments.length) {
                // XML format: each entry is already a clean segment
                // Create 1:1 sentence mapping for simple formats
                result = {
                    segments,
                    sentences: segments.map((s, i) => ({
                        text: s.text,
                        translation: null,
                        segmentIndices: [i]
                    }))
                };
                segments.forEach((s, i) => { s.sentIdx = i; });
            }
        }

        if (!result || !result.segments.length) return;

        console.log(`[YT Bilingual] Loaded ${result.segments.length} segments, ${result.sentences.length} sentences`);
        // Cancel any previous pre-translation run
        this.preTranslating = false;
        this.captions = result.segments;      // for English display (original timing)
        this.sentences = result.sentences;     // for Chinese translation (semantic groups)
        this.lastRenderedText = '';
        this.translationAbortKey++;
        this.contextBuffer = [];

        // Hide YouTube's own caption layer
        this.hideNativeCaptions(true);

        // Start background pre-translation with warmup phase
        if (this.settings.autoTranslate) {
            setTimeout(() => this.warmupAndTranslate(), 500);
        }
    },

    /**
     * Phase 1: Pause video, pre-translate the first WARMUP_COUNT SENTENCES,
     * show progress overlay, then resume and continue pre-translating the rest.
     * Sentences (not segments) are the translation units.
     */
    async warmupAndTranslate() {
        const WARMUP_COUNT = 8; // first 8 sentences
        const video = document.querySelector('video');
        const wasPlaying = video && !video.paused;

        // Pause video during warmup
        if (video && !video.paused) {
            video.pause();
        }

        const total = Math.min(WARMUP_COUNT, this.sentences.length);
        this.showWarmupOverlay(0, total);

        // Pre-translate first batch of SENTENCES
        this.preTranslating = true;
        let translated = 0;

        const BATCH_SIZE = 3;
        let i = 0;
        while (i < total && this.preTranslating) {
            const batch = [];
            while (batch.length < BATCH_SIZE && i < total) {
                const sent = this.sentences[i];
                if (sent.translation === null) {
                    sent.translation = '__pending__';
                    batch.push(sent);
                }
                i++;
            }
            if (!batch.length) continue;

            const ctx = this.contextBuffer.slice(-3);
            await Promise.allSettled(batch.map(async (sent) => {
                try {
                    const translation = await TranslatorService.translate(
                        sent.text,
                        this.settings.targetLanguage,
                        this.settings.nativeLanguage,
                        this.settings,
                        ctx,
                        'quality'
                    );
                    sent.translation = translation || '';
                    if (translation) {
                        this.contextBuffer.push({ original: sent.text, translated: translation });
                        if (this.contextBuffer.length > 8) this.contextBuffer.shift();
                    }
                } catch (err) {
                    console.warn('[YT Bilingual] Warmup translate failed:', err.message);
                    sent.translation = '';
                }
                translated++;
                this.showWarmupOverlay(translated, total);
            }));
        }

        // Remove overlay and resume video
        this.hideWarmupOverlay();
        if (wasPlaying && video) {
            video.play();
        }

        console.log(`[YT Bilingual] Warmup complete (${translated}/${total}), resuming playback`);

        // Phase 2: continue pre-translating the remaining sentences
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
     * Pre-translate remaining SENTENCES in the background with CONCURRENCY.
     * @param {number} startFrom - Sentence index to start from (after warmup)
     */
    async startPreTranslation(startFrom = 0) {
        this.preTranslating = true;
        console.log(`[YT Bilingual] Background pre-translation from sentence ${startFrom}`);
        const BATCH_SIZE = 3;

        let i = startFrom;
        while (i < this.sentences.length && this.preTranslating) {
            const batch = [];
            while (batch.length < BATCH_SIZE && i < this.sentences.length) {
                const sent = this.sentences[i];
                if (sent.translation === null) {
                    sent.translation = '__pending__';
                    batch.push(sent);
                }
                i++;
            }
            if (!batch.length) continue;

            const ctx = this.contextBuffer.slice(-3);
            await Promise.allSettled(batch.map(async (sent) => {
                try {
                    const translation = await TranslatorService.translate(
                        sent.text,
                        this.settings.targetLanguage,
                        this.settings.nativeLanguage,
                        this.settings,
                        ctx,
                        'quality'
                    );
                    sent.translation = translation || '';
                    if (translation) {
                        this.contextBuffer.push({ original: sent.text, translated: translation });
                        if (this.contextBuffer.length > 8) this.contextBuffer.shift();
                        // If currently displaying a segment from this sentence, update translation
                        const currentSeg = this.captions.find(c => c.text === this.lastRenderedText);
                        if (currentSeg && this.sentences[currentSeg.sentIdx] === sent) {
                            this.renderSubtitle(currentSeg.text, translation, false);
                        }
                    }
                } catch (err) {
                    console.warn('[YT Bilingual] Pre-translate failed:', err.message);
                    sent.translation = '';
                }
            }));

            await new Promise(r => setTimeout(r, 10));
        }
        this.preTranslating = false;
        console.log('[YT Bilingual] Pre-translation complete');
    },

    /**
     * Parse YouTube JSON3 caption format.
     *
     * Returns TWO arrays:
     * - segments[]: Original YouTube events with exact timing (for English display)
     * - sentences[]: Accumulated semantic sentences (for Chinese translation)
     *
     * Each segment has a `sentIdx` linking it to its parent sentence.
     * This dual-layer approach ensures English perfectly syncs with audio
     * while Chinese translation can span multiple segments.
     */
    parseJSON3(json) {
        // Step 1: collect events with text
        const raw = [];
        for (const ev of json.events) {
            if (!ev.segs || !ev.dDurationMs) continue;
            const text = ev.segs
                .map(s => (s.utf8 || '').replace(/\n/g, ' '))
                .join('').trim();
            if (!text) continue;
            raw.push({ startMs: ev.tStartMs, endMs: ev.tStartMs + ev.dDurationMs, text });
        }
        if (!raw.length) return { segments: [], sentences: [] };
        raw.sort((a, b) => a.startMs - b.startMs);

        // Step 2: dedup by startMs (keep longest text for each timestamp)
        const byStart = new Map();
        for (const e of raw) {
            const ex = byStart.get(e.startMs);
            if (!ex || e.text.length > ex.text.length) byStart.set(e.startMs, e);
        }
        const events = Array.from(byStart.values()).sort((a, b) => a.startMs - b.startMs);

        // Step 3: Create SEGMENTS from events (for English display)
        // Each event becomes a display segment with original timing.
        // Make timing contiguous so subtitles stay on screen until the next one starts.
        const segments = events.map(e => ({
            startMs: e.startMs,
            endMs: e.endMs,
            text: e.text,
            sentIdx: -1   // will be set in step 5
        }));

        for (let s = 0; s < segments.length - 1; s++) {
            segments[s].endMs = Math.max(segments[s].endMs, segments[s + 1].startMs);
        }

        // Step 4: Accumulate events into SENTENCES for translation
        // (same rolling-window logic as before, but now decoupled from display)
        const GAP_MS = 600;
        const MAX_CHARS = 100;
        const sentenceRanges = []; // { text, startSegIdx, endSegIdx }

        let sentStartIdx = 0;
        let accText = events[0].text;
        let prevText = events[0].text;
        let prevEndMs = events[0].endMs;

        const flushSent = (endIdx) => {
            const t = accText.trim();
            if (t) {
                sentenceRanges.push({
                    text: t,
                    translation: null,
                    segmentIndices: Array.from({ length: endIdx - sentStartIdx + 1 }, (_, i) => sentStartIdx + i)
                });
            }
        };

        const splitEmbedded = (splitIdx) => {
            let m = accText.match(/^([\s\S]*?[.!?。！？])\s+([\s\S]+)$/);
            if (!m && accText.length > 70) {
                const minIdx = Math.floor(accText.length * 0.4);
                const match = accText.slice(minIdx).match(/\s+(and|but|so|because|where|which|that)\s+/i);
                if (match) {
                    const idx = minIdx + match.index;
                    m = [accText, accText.slice(0, idx).trim(), accText.slice(idx + 1).trim()];
                }
            }
            if (!m) return false;
            sentenceRanges.push({
                text: m[1].trim(),
                translation: null,
                segmentIndices: Array.from({ length: splitIdx - sentStartIdx }, (_, i) => sentStartIdx + i)
            });
            sentStartIdx = splitIdx;
            accText = m[2].trim();
            return true;
        };

        const splitComma = (splitIdx) => {
            if (accText.length <= MAX_CHARS) return false;
            const minIdx = Math.floor(accText.length * 0.4);
            const idx = accText.indexOf(', ', minIdx);
            if (idx === -1) return false;
            const before = accText.slice(0, idx + 1).trim();
            const after = accText.slice(idx + 2).trim();
            if (!after) return false;
            sentenceRanges.push({
                text: before,
                translation: null,
                segmentIndices: Array.from({ length: splitIdx - sentStartIdx }, (_, i) => sentStartIdx + i)
            });
            sentStartIdx = splitIdx;
            accText = after;
            return true;
        };

        for (let i = 1; i < events.length; i++) {
            const curr = events[i];
            const gap = curr.startMs - prevEndMs;

            if (gap > GAP_MS) {
                flushSent(i - 1);
                sentStartIdx = i;
                accText = curr.text;
                prevText = curr.text;
                prevEndMs = curr.endMs;
                continue;
            }

            // Find rolling window overlap
            const prevWords = prevText.split(/\s+/).filter(Boolean);
            const currWords = curr.text.split(/\s+/).filter(Boolean);
            let overlap = 0;
            for (let len = Math.min(prevWords.length, currWords.length); len > 0; len--) {
                if (prevWords.slice(-len).join(' ').toLowerCase() ===
                    currWords.slice(0, len).join(' ').toLowerCase()) {
                    overlap = len; break;
                }
            }
            const newWords = overlap > 0 ? currWords.slice(overlap) : currWords;
            if (newWords.length > 0) accText += ' ' + newWords.join(' ');
            prevText = curr.text;
            prevEndMs = curr.endMs;

            if (splitEmbedded(i)) continue;
            splitComma(i);
        }
        flushSent(events.length - 1);

        // Step 5: Link segments to sentences
        for (let si = 0; si < sentenceRanges.length; si++) {
            for (const segIdx of sentenceRanges[si].segmentIndices) {
                if (segIdx >= 0 && segIdx < segments.length) {
                    segments[segIdx].sentIdx = si;
                }
            }
        }
        // Fill any unlinked segments (edge cases)
        let lastSentIdx = 0;
        for (const seg of segments) {
            if (seg.sentIdx === -1) seg.sentIdx = lastSentIdx;
            else lastSentIdx = seg.sentIdx;
        }

        console.log(`[YT Bilingual] ${segments.length} segments, ${sentenceRanges.length} sentences`);
        return { segments, sentences: sentenceRanges };
    },


    /** Parse legacy XML timedtext format */
    parseXML(xml) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, 'text/xml');
            return Array.from(doc.querySelectorAll('text')).map(el => {
                const start = parseFloat(el.getAttribute('start') || '0') * 1000;
                const dur = parseFloat(el.getAttribute('dur') || '2') * 1000;
                return {
                    startMs: start,
                    endMs: start + dur,
                    text: el.textContent.trim(),
                    sentIdx: 0
                };
            }).filter(e => e.text);
        } catch {
            return [];
        }
    },

    // ── Timeupdate listener ───────────────────────────────────────────────────

    attachTimeupdateListener() {
        const attach = () => {
            const video = document.querySelector('video');
            if (!video) { setTimeout(attach, 500); return; }

            if (this.timeupdateHandler) {
                video.removeEventListener('timeupdate', this.timeupdateHandler);
            }

            this.timeupdateHandler = () => this.onTimeUpdate(video.currentTime);
            video.addEventListener('timeupdate', this.timeupdateHandler);
        };
        attach();
    },

    onTimeUpdate(currentTimeSec) {
        if (!this.captions.length) return;

        const ms = currentTimeSec * 1000;
        // Find the SEGMENT whose window contains current time (for English display)
        const segment = this.captions.find(c => ms >= c.startMs && ms < c.endMs);

        if (!segment) {
            // Between segments — clear display
            if (this.lastRenderedText !== '') {
                this.lastRenderedText = '';
                if (this.subtitleContainer) this.subtitleContainer.innerHTML = '';
            }
            return;
        }

        if (segment.text === this.lastRenderedText) return; // already showing this
        this.lastRenderedText = segment.text;

        // Get SENTENCE translation for this segment
        const sentence = this.sentences[segment.sentIdx];
        const translation = sentence ? sentence.translation : null;

        // Determine loading state
        const needsTranslation = this.settings.autoTranslate && (!translation || translation === null);
        const displayTranslation = (translation && translation !== '__pending__') ? translation : null;

        // Render: English from segment, Chinese from sentence
        this.renderSubtitle(segment.text, displayTranslation, needsTranslation);

        // If sentence hasn't been translated yet, request on-demand translation
        if (sentence && sentence.translation === null && this.settings.autoTranslate) {
            sentence.translation = '__pending__';
            const recentContext = this.contextBuffer.slice(-5);
            TranslatorService.translate(
                sentence.text,
                this.settings.targetLanguage,
                this.settings.nativeLanguage,
                this.settings,
                recentContext,
                'quality'
            ).then(trans => {
                sentence.translation = trans || '';
                if (trans) {
                    this.contextBuffer.push({ original: sentence.text, translated: trans });
                    if (this.contextBuffer.length > 8) this.contextBuffer.shift();
                    // Update display if we're still showing a segment from this sentence
                    const currentSeg = this.captions.find(c => c.text === this.lastRenderedText);
                    if (currentSeg && currentSeg.sentIdx === segment.sentIdx) {
                        this.renderSubtitle(currentSeg.text, trans, false);
                    }
                }
            }).catch(err => {
                console.error('[YT Bilingual] Translation error:', err);
                sentence.translation = '';
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
        const video = document.querySelector('video');
        if (video && this.timeupdateHandler) {
            video.removeEventListener('timeupdate', this.timeupdateHandler);
        }
        if (this.subtitleContainer) this.subtitleContainer.remove();
        this.subtitleContainer = null;
        this.captions = [];
        this.sentences = [];
        this.lastRenderedText = '';
        this.contextBuffer = [];
        this.hideNativeCaptions(false);
    }
};
