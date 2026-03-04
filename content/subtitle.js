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
        let entries = [];
        try {
            // YouTube JSON3 format (most common for modern captions)
            const json = JSON.parse(rawText);
            if (json.events) {
                entries = this.parseJSON3(json);
            }
        } catch {
            // Fallback: XML timedtext format
            entries = this.parseXML(rawText);
        }

        if (!entries.length) return;

        console.log(`[YT Bilingual] Loaded ${entries.length} caption entries`);
        // Cancel any previous pre-translation run
        this.preTranslating = false;
        this.captions = entries;
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
     * Phase 1: Pause video, pre-translate the first WARMUP_COUNT subtitles,
     * show progress overlay, then resume and continue pre-translating the rest.
     * This ensures ALL displayed subtitles are high-quality (TRR).
     */
    async warmupAndTranslate() {
        const WARMUP_COUNT = 8; // ~30-60 seconds of video
        const video = document.querySelector('video');
        const wasPlaying = video && !video.paused;

        // Pause video during warmup
        if (video && !video.paused) {
            video.pause();
        }

        // Show warmup overlay
        this.showWarmupOverlay(0, Math.min(WARMUP_COUNT, this.captions.length));

        // Pre-translate first batch sequentially (need context chain)
        this.preTranslating = true;
        let translated = 0;
        const total = Math.min(WARMUP_COUNT, this.captions.length);

        // Use batches of 3 for concurrency during warmup too
        const BATCH_SIZE = 3;
        let i = 0;
        while (i < total && this.preTranslating) {
            const batch = [];
            while (batch.length < BATCH_SIZE && i < total) {
                const entry = this.captions[i];
                if (entry.translation === null) {
                    entry.translation = '__pending__';
                    batch.push(entry);
                }
                i++;
            }
            if (!batch.length) continue;

            const ctx = this.contextBuffer.slice(-3);
            await Promise.allSettled(batch.map(async (entry) => {
                try {
                    const translation = await TranslatorService.translate(
                        entry.text,
                        this.settings.targetLanguage,
                        this.settings.nativeLanguage,
                        this.settings,
                        ctx,
                        'quality'
                    );
                    entry.translation = translation || '';
                    if (translation) {
                        this.contextBuffer.push({ original: entry.text, translated: translation });
                        if (this.contextBuffer.length > 8) this.contextBuffer.shift();
                    }
                } catch (err) {
                    console.warn('[YT Bilingual] Warmup translate failed:', err.message);
                    entry.translation = '';
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

        // Phase 2: continue pre-translating the remaining subtitles
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
                    entry.translation = '__pending__';
                    batch.push({ entry, index: i });
                }
                i++;
            }
            if (!batch.length) continue;

            const ctx = this.contextBuffer.slice(-3);
            await Promise.allSettled(batch.map(async ({ entry }) => {
                try {
                    const translation = await TranslatorService.translate(
                        entry.text,
                        this.settings.targetLanguage,
                        this.settings.nativeLanguage,
                        this.settings,
                        ctx,
                        'quality'
                    );
                    entry.translation = translation || '';
                    if (translation) {
                        this.contextBuffer.push({ original: entry.text, translated: translation });
                        if (this.contextBuffer.length > 8) this.contextBuffer.shift();
                        if (this.lastRenderedText === entry.text) {
                            this.renderSubtitle(entry.text, translation, false);
                        }
                    }
                } catch (err) {
                    console.warn('[YT Bilingual] Pre-translate failed:', err.message);
                    entry.translation = '';
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
     * Auto-gen captions use a ROLLING WINDOW - each event is a short
     * sliding phrase. We accumulate new words and split at sentence
     * boundaries (embedded '.' or gap > 600ms) and max 100 chars.
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
        if (!raw.length) return [];
        raw.sort((a, b) => a.startMs - b.startMs);

        // Step 2: dedup by startMs
        const byStart = new Map();
        for (const e of raw) {
            const ex = byStart.get(e.startMs);
            if (!ex || e.text.length > ex.text.length) byStart.set(e.startMs, e);
        }
        const events = Array.from(byStart.values()).sort((a, b) => a.startMs - b.startMs);

        // Step 3: rolling window accumulation with sentence splitting
        const GAP_MS = 600;  // pause = new sentence
        const MAX_CHARS = 100;  // max chars per subtitle
        const sentences = [];

        let sentStart = events[0].startMs;
        let sentEnd = events[0].endMs;
        let accText = events[0].text;
        let prevText = events[0].text;
        let prevEndMs = events[0].endMs;

        const flush = (endMs) => {
            const t = accText.trim();
            if (t) sentences.push({ startMs: sentStart, endMs: endMs || sentEnd, text: t, translation: null });
        };

        // Split accText at the FIRST embedded sentence boundary or conjunction
        // e.g. "...in tech. You need real" -> split into two entries
        const splitEmbedded = (approxMs) => {
            let m = accText.match(/^([\s\S]*?[.!?。！？])\s+([\s\S]+)$/);

            // If it's getting too long, also split at major conjunctions
            if (!m && accText.length > 70) {
                // look for ' and ', ' but ', ' so ', ' because ', etc. near the middle
                const minIdx = Math.floor(accText.length * 0.4);
                const match = accText.slice(minIdx).match(/\s+(and|but|so|because|where|which|that)\s+/i);
                if (match) {
                    const idx = minIdx + match.index;
                    m = [
                        accText,
                        accText.slice(0, idx).trim(),
                        accText.slice(idx + 1).trim() // keep the conjunction in the second part
                    ];
                }
            }
            if (!m) return false;
            sentences.push({ startMs: sentStart, endMs: approxMs, text: m[1].trim(), translation: null });
            sentStart = approxMs;
            sentEnd = approxMs;
            accText = m[2].trim();
            return true;
        };

        // Split at comma when text is too long
        const splitComma = (approxMs) => {
            if (accText.length <= MAX_CHARS) return false;
            const minIdx = Math.floor(accText.length * 0.4);
            const idx = accText.indexOf(', ', minIdx);
            if (idx === -1) return false;
            const before = accText.slice(0, idx + 1).trim();
            const after = accText.slice(idx + 2).trim();
            if (!after) return false;
            sentences.push({ startMs: sentStart, endMs: approxMs, text: before, translation: null });
            sentStart = approxMs;
            sentEnd = approxMs;
            accText = after;
            return true;
        };

        for (let i = 1; i < events.length; i++) {
            const curr = events[i];
            const gap = curr.startMs - prevEndMs;

            if (gap > GAP_MS) {
                flush(prevEndMs);
                sentStart = curr.startMs;
                sentEnd = curr.endMs;
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
            sentEnd = Math.max(sentEnd, curr.endMs);
            prevText = curr.text;
            prevEndMs = curr.endMs;

            // Check for embedded sentence boundary FIRST
            if (splitEmbedded(curr.startMs)) { sentEnd = curr.endMs; continue; }
            // Then overflow comma split
            splitComma(curr.startMs);
        }
        flush();

        // Step 4: Make timing CONTIGUOUS — no gaps between consecutive sentences.
        // This ensures a subtitle stays on screen until the next one begins,
        // matching the audio timing exactly like Language Reactor does.
        for (let s = 0; s < sentences.length - 1; s++) {
            // Extend current sentence's end to the next sentence's start
            // (eliminates flicker/gaps where no subtitle is shown)
            sentences[s].endMs = Math.max(sentences[s].endMs, sentences[s + 1].startMs);
        }

        console.log(`[YT Bilingual] ${sentences.length} sentences from ${events.length} events`);
        return sentences;
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
                    translation: null
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
        const needsTranslation = this.settings.autoTranslate && entry.translation === null;
        // Show immediately with full original text
        this.renderSubtitle(entry.text, entry.translation, needsTranslation);

        // Request translation only once per entry.
        // Use '__pending__' sentinel to prevent duplicate in-flight requests.
        if (needsTranslation) {
            entry.translation = '__pending__'; // lock so timeupdate doesn't re-queue
            const recentContext = this.contextBuffer.slice(-5);
            TranslatorService.translate(
                entry.text,
                this.settings.targetLanguage,
                this.settings.nativeLanguage,
                this.settings,
                recentContext,
                'quality' // always use quality mode — warmup ensures we rarely reach here
            ).then(translation => {
                entry.translation = translation || '';
                if (this.lastRenderedText === entry.text && translation) {
                    this.contextBuffer.push({ original: entry.text, translated: translation });
                    if (this.contextBuffer.length > 8) this.contextBuffer.shift();
                    this.renderSubtitle(entry.text, translation, false);
                }
            }).catch(err => {
                console.error('[YT Bilingual] Translation error:', err);
                entry.translation = '';
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
            tokens.forEach(token => {
                if (isWord(token)) {
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
                            // doesn't → doesn → NOT useful; map common negatives to their root
                            stemForLookup = stemForLookup.slice(0, -3); // doesn't → doesn
                            // Additional exceptions: map back to root verb
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

                        // Very common short words that may be missing from frequency lists
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

                            // Check both the stem (e.g. "does") and the full token (e.g. "doesn")
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
                    if (!['zh', 'ja', 'ko'].includes(settings.targetLanguage)) {
                        line.appendChild(document.createTextNode(' '));
                    }
                } else {
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
        this.lastRenderedText = '';
        this.contextBuffer = [];
        this.hideNativeCaptions(false);
    }
};
