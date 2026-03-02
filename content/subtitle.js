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

    /** Parse YouTube JSON3 caption format */
    parseJSON3(json) {
        const entries = [];
        let pendingStart = null;
        let pendingText = '';

        for (const ev of json.events) {
            if (!ev.segs) continue;
            const text = ev.segs.map(s => s.utf8 || '').join('').trim();
            if (!text || text === '\n') continue;

            // JSON3 can have many short-overlap events; merge consecutive non-blank
            entries.push({
                startMs: ev.tStartMs,
                endMs: ev.tStartMs + (ev.dDurationMs || 2000),
                text,
                translation: null
            });
        }

        // Merge very short overlapping segments (< 50 ms gap → same sentence)
        const merged = [];
        for (const e of entries) {
            const prev = merged[merged.length - 1];
            if (prev && e.startMs - prev.endMs < 50 && prev.text.length < 200) {
                // Append to previous if it's the same rolling window
                if (!prev.text.includes(e.text)) {
                    prev.text = e.text; // take the latest (longer) version
                    prev.endMs = e.endMs;
                } else {
                    prev.endMs = e.endMs;
                }
            } else {
                merged.push({ ...e });
            }
        }
        return merged;
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

        // --- Render immediately with the full sentence ---
        this.renderSubtitle(entry.text, entry.translation, /* loading */ entry.translation === null && this.settings.autoTranslate);

        // --- Request translation if not yet cached ---
        if (this.settings.autoTranslate && entry.translation === null) {
            const key = ++this.translationAbortKey;
            TranslatorService.translate(
                entry.text,
                this.settings.targetLanguage,
                this.settings.nativeLanguage,
                this.settings
            ).then(translation => {
                if (!translation) return;
                entry.translation = translation; // cache on the entry object
                // Only update display if this entry is still active
                if (this.lastRenderedText === entry.text) {
                    this.renderSubtitle(entry.text, translation, false);
                }
            }).catch(err => {
                console.error('[YT Bilingual] Translation error:', err);
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

            if (loading) {
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
