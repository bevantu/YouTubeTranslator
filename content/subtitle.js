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
        this.captions = entries;
        this.lastRenderedText = '';
        this.translationAbortKey++;

        // Hide YouTube's own caption layer
        this.hideNativeCaptions(true);
    },

    /**
   * Parse YouTube JSON3 caption format.
   *
   * YouTube auto-generated captions use a "rolling window" where many
   * events share the same tStartMs and differ only in which words are
   * included.  We keep one entry per unique tStartMs, taking the longest
   * text (the most-complete window) for that timestamp.
   * We then set endMs = next entry's startMs so there are no gaps.
   */
    parseJSON3(json) {
        // Step 1: collect all events that have actual text
        const raw = [];
        for (const ev of json.events) {
            if (!ev.segs || !ev.dDurationMs) continue;
            const text = ev.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join('').trim();
            if (!text) continue;
            raw.push({ startMs: ev.tStartMs, dMs: ev.dDurationMs, text });
        }
        if (!raw.length) return [];

        // Step 2: group by startMs, keep longest text per group
        const byStart = new Map();
        for (const e of raw) {
            const existing = byStart.get(e.startMs);
            if (!existing || e.text.length > existing.text.length) {
                byStart.set(e.startMs, e);
            }
        }

        // Step 3: sort by start time
        const sorted = Array.from(byStart.values()).sort((a, b) => a.startMs - b.startMs);

        // Step 4: build final entries, endMs = next entry's startMs (no gaps)
        return sorted.map((e, i) => ({
            startMs: e.startMs,
            endMs: i + 1 < sorted.length ? sorted[i + 1].startMs : e.startMs + e.dMs,
            text: e.text,
            translation: null   // null = not translated yet
        }));
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
            TranslatorService.translate(
                entry.text,
                this.settings.targetLanguage,
                this.settings.nativeLanguage,
                this.settings
            ).then(translation => {
                entry.translation = translation || '';
                // Update display only if this entry is still on screen
                if (this.lastRenderedText === entry.text && translation) {
                    this.renderSubtitle(entry.text, translation, false);
                }
            }).catch(err => {
                console.error('[YT Bilingual] Translation error:', err);
                entry.translation = ''; // unlock so it can retry next time
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

                    const key = `${settings.targetLanguage}:${token.toLowerCase()}`;
                    const entry = this.vocabulary[key];
                    if (entry) {
                        span.classList.add(entry.status === 'known' ? 'yb-word-known' : 'yb-word-learning');
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
        const video = document.querySelector('video');
        if (video && this.timeupdateHandler) {
            video.removeEventListener('timeupdate', this.timeupdateHandler);
        }
        if (this.subtitleContainer) this.subtitleContainer.remove();
        this.subtitleContainer = null;
        this.captions = [];
        this.lastRenderedText = '';
        this.hideNativeCaptions(false);
    }
};
