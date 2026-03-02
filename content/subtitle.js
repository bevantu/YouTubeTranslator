/**
 * Subtitle extraction and rendering
 * Intercepts YouTube's captions and renders bilingual subtitles.
 *
 * Key design decisions:
 * - Debounce the MutationObserver callback: YouTube renders captions
 *   word-by-word with animations; we wait 400ms of silence before we
 *   treat the current text as a "complete" subtitle line.
 * - Only fire a translation request when the text has actually stabilised.
 * - Translation requests go to the Background SW via TranslatorService.
 */
const SubtitleManager = {
    observer: null,
    subtitleContainer: null,
    settings: null,
    vocabulary: {},
    subtitleIndex: 0,
    lastCaptionText: '',
    debounceTimer: null,
    translationAbortKey: 0,   // incremented to cancel stale translations

    // ── Init ────────────────────────────────────────────────────────────────

    async init(settings) {
        this.settings = settings;
        this.vocabulary = await StorageHelper.getVocabulary();
        this.createSubtitleContainer();
        this.observeSubtitles();

        document.addEventListener('yb-vocabulary-updated', async () => {
            this.vocabulary = await StorageHelper.getVocabulary();
        });
    },

    // ── Subtitle container ───────────────────────────────────────────────────

    createSubtitleContainer() {
        if (this.subtitleContainer) return;

        this.subtitleContainer = document.createElement('div');
        this.subtitleContainer.id = 'yt-bilingual-subtitles';
        this.subtitleContainer.className = 'yb-subtitle-container';

        const insert = () => {
            const player = document.querySelector('#movie_player');
            if (player && !document.getElementById('yt-bilingual-subtitles')) {
                player.appendChild(this.subtitleContainer);
                return true;
            }
            return false;
        };
        if (!insert()) {
            const iv = setInterval(() => { if (insert()) clearInterval(iv); }, 500);
        }
    },

    // ── Observer ─────────────────────────────────────────────────────────────

    observeSubtitles() {
        const startObserving = () => {
            const captionWindow = document.querySelector('.ytp-caption-window-container');
            if (!captionWindow) {
                setTimeout(startObserving, 1000);
                return;
            }

            this.observer = new MutationObserver(() => this.scheduleUpdate());
            this.observer.observe(captionWindow, {
                childList: true,
                subtree: true,
                characterData: true
            });
        };
        startObserving();
    },

    // ── Debounce ─────────────────────────────────────────────────────────────

    /**
     * Called on every DOM mutation inside the caption window.
     * We wait 400 ms after the LAST mutation before committing to a render.
     * This prevents the "word dripping" effect caused by YouTube's word-by-word
     * caption animation.
     */
    scheduleUpdate() {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.handleCaptionChange(), 400);
    },

    // ── Caption change handler ────────────────────────────────────────────────

    async handleCaptionChange() {
        // Collect all visible caption segment text
        const segments = document.querySelectorAll('.ytp-caption-segment');
        if (!segments.length) {
            if (this.subtitleContainer) this.subtitleContainer.innerHTML = '';
            return;
        }

        const captionText = Array.from(segments)
            .map(s => s.textContent)
            .join('')
            .trim();

        if (!captionText || captionText === this.lastCaptionText) return;
        this.lastCaptionText = captionText;

        // Hide YouTube's own subtitle layer
        const captionWindow = document.querySelector('.ytp-caption-window-container');
        if (captionWindow) {
            captionWindow.style.opacity = '0';
            captionWindow.style.pointerEvents = 'none';
        }

        const video = document.querySelector('video');
        const currentTime = video ? video.currentTime : 0;

        this.subtitleIndex++;
        const index = this.subtitleIndex;

        // Render original line immediately; translation slot shows a spinner
        this.renderSubtitle(captionText, null, index, /* loading */ true);

        SubtitlePanel.addSubtitle(captionText, '', currentTime, index);
        SubtitlePanel.setActive(index);

        // Translate asynchronously
        if (this.settings.autoTranslate) {
            const abortKey = ++this.translationAbortKey;
            try {
                const translation = await TranslatorService.translate(
                    captionText,
                    this.settings.targetLanguage,
                    this.settings.nativeLanguage,
                    this.settings
                );
                // Only apply if this subtitle is still current
                if (abortKey === this.translationAbortKey) {
                    this.renderSubtitle(captionText, translation, index, false);
                    SubtitlePanel.updateSubtitleTranslation(index, translation);
                }
            } catch (err) {
                console.error('[YT Bilingual] Translation failed:', err);
                if (abortKey === this.translationAbortKey) {
                    this.renderSubtitle(captionText, '', index, false);
                }
            }
        }
    },

    // ── Render ────────────────────────────────────────────────────────────────

    /**
     * @param {string}  original    - Source text
     * @param {string|null} translation - Translated text (null = not yet available)
     * @param {number}  index       - Subtitle index (for stale-check)
     * @param {boolean} loading     - Show loading indicator for translation
     */
    renderSubtitle(original, translation, index, loading) {
        if (!this.subtitleContainer) return;

        const settings = this.settings;
        const container = this.subtitleContainer;
        container.innerHTML = '';

        // Click on subtitle background: pause/play
        container.onclick = (e) => {
            if (e.target.classList.contains('yb-word')) return;
            const v = document.querySelector('video');
            if (v) v.paused ? v.play() : v.pause();
        };

        // ── Original line ──────────────────────────────────────────────────
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

                    span.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const v = document.querySelector('video');
                        if (v && !v.paused) v.pause();
                        WordPopup.show(span, token, original, settings.targetLanguage, settings.nativeLanguage, settings);
                    });

                    line.appendChild(span);

                    // Space after word for non-CJK
                    if (!['zh', 'ja', 'ko'].includes(settings.targetLanguage)) {
                        line.appendChild(document.createTextNode(' '));
                    }
                } else {
                    line.appendChild(document.createTextNode(token));
                }
            });

            container.appendChild(line);
        }

        // ── Translation line ───────────────────────────────────────────────
        if (settings.showTranslatedSubtitle) {
            const tLine = document.createElement('div');
            tLine.className = 'yb-subtitle-line yb-subtitle-translation';
            tLine.style.fontSize = `${Math.max(12, settings.fontSize - 2)}px`;

            if (loading) {
                tLine.innerHTML = '<span class="yb-translating">⋯</span>';
            } else if (translation) {
                tLine.textContent = translation;
            } else {
                return; // no translation, no line
            }

            container.appendChild(tLine);
        }
    },

    // ── Misc ──────────────────────────────────────────────────────────────────

    async updateSettings(newSettings) {
        this.settings = newSettings;
        this.vocabulary = await StorageHelper.getVocabulary();
    },

    destroy() {
        if (this.observer) this.observer.disconnect();
        clearTimeout(this.debounceTimer);
        if (this.subtitleContainer) this.subtitleContainer.remove();
        this.subtitleContainer = null;
        this.lastCaptionText = '';

        const cw = document.querySelector('.ytp-caption-window-container');
        if (cw) {
            cw.style.opacity = '';
            cw.style.pointerEvents = '';
        }
    }
};
