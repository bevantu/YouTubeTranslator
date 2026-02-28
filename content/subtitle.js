/**
 * Subtitle extraction and rendering
 * Intercepts YouTube's captions and renders bilingual subtitles
 */
const SubtitleManager = {
    observer: null,
    currentSubtitle: '',
    subtitleContainer: null,
    settings: null,
    vocabulary: {},
    subtitleIndex: 0,
    isTranslating: false,
    lastCaptionText: '',

    /**
     * Initialize subtitle manager
     */
    async init(settings) {
        this.settings = settings;
        this.vocabulary = await StorageHelper.getVocabulary();
        this.createSubtitleContainer();
        this.observeSubtitles();

        // Listen for vocabulary updates
        document.addEventListener('yb-vocabulary-updated', async () => {
            this.vocabulary = await StorageHelper.getVocabulary();
        });
    },

    /**
     * Create custom subtitle container
     */
    createSubtitleContainer() {
        if (this.subtitleContainer) return;

        this.subtitleContainer = document.createElement('div');
        this.subtitleContainer.id = 'yt-bilingual-subtitles';
        this.subtitleContainer.className = 'yb-subtitle-container';

        // Insert in the video player
        const insertSubtitle = () => {
            const player = document.querySelector('#movie_player');
            if (player && !document.getElementById('yt-bilingual-subtitles')) {
                player.appendChild(this.subtitleContainer);
                return true;
            }
            return false;
        };

        if (!insertSubtitle()) {
            const interval = setInterval(() => {
                if (insertSubtitle()) clearInterval(interval);
            }, 500);
        }
    },

    /**
     * Observe YouTube's native caption changes
     */
    observeSubtitles() {
        // Monitor for caption element changes
        const startObserving = () => {
            const captionWindow = document.querySelector('.ytp-caption-window-container');
            if (!captionWindow) {
                setTimeout(startObserving, 1000);
                return;
            }

            this.observer = new MutationObserver((mutations) => {
                this.handleCaptionChange();
            });

            this.observer.observe(captionWindow, {
                childList: true,
                subtree: true,
                characterData: true
            });
        };

        startObserving();

        // Also poll for changes as a fallback
        setInterval(() => this.handleCaptionChange(), 500);
    },

    /**
     * Handle caption text change
     */
    async handleCaptionChange() {
        const captionSegments = document.querySelectorAll('.ytp-caption-segment');
        if (!captionSegments.length) {
            if (this.subtitleContainer) {
                this.subtitleContainer.innerHTML = '';
            }
            return;
        }

        let captionText = '';
        captionSegments.forEach(seg => {
            captionText += seg.textContent;
        });
        captionText = captionText.trim();

        if (!captionText || captionText === this.lastCaptionText) return;
        this.lastCaptionText = captionText;

        // Hide original YouTube subtitles
        const captionWindow = document.querySelector('.ytp-caption-window-container');
        if (captionWindow) {
            captionWindow.style.opacity = '0';
            captionWindow.style.pointerEvents = 'none';
        }

        // Get video current time
        const video = document.querySelector('video');
        const currentTime = video ? video.currentTime : 0;

        this.subtitleIndex++;
        const index = this.subtitleIndex;

        // Render original subtitle
        this.renderBilingualSubtitle(captionText, null, index);

        // Add to panel
        SubtitlePanel.addSubtitle(captionText, '', currentTime, index);
        SubtitlePanel.setActive(index);

        // Translate if enabled
        if (this.settings.autoTranslate && !this.isTranslating) {
            this.isTranslating = true;
            try {
                const translation = await TranslatorService.translate(
                    captionText,
                    this.settings.targetLanguage,
                    this.settings.nativeLanguage,
                    this.settings
                );

                // Only update if this is still the current subtitle
                if (this.subtitleIndex === index) {
                    this.renderBilingualSubtitle(captionText, translation, index);
                }
                SubtitlePanel.updateSubtitleTranslation(index, translation);
            } catch (err) {
                console.error('[YT Bilingual] Translation failed:', err);
            }
            this.isTranslating = false;
        }
    },

    /**
     * Render bilingual subtitle with word highlighting
     */
    renderBilingualSubtitle(original, translation, index) {
        if (!this.subtitleContainer) return;

        const settings = this.settings;
        const container = this.subtitleContainer;
        container.innerHTML = '';

        // Click on subtitle area pauses/plays video
        container.onclick = (e) => {
            if (e.target.classList.contains('yb-word')) return; // Word click handled separately
            const video = document.querySelector('video');
            if (video) {
                if (video.paused) {
                    video.play();
                } else {
                    video.pause();
                }
            }
        };

        // Original subtitle line
        if (settings.showOriginalSubtitle) {
            const originalLine = document.createElement('div');
            originalLine.className = 'yb-subtitle-line yb-subtitle-original';
            originalLine.style.fontSize = `${settings.fontSize}px`;

            // Tokenize and create word spans
            const tokens = tokenizeText(original, settings.targetLanguage);
            tokens.forEach(token => {
                if (isWord(token)) {
                    const wordSpan = document.createElement('span');
                    wordSpan.className = 'yb-word';
                    wordSpan.textContent = token;

                    // Check vocabulary status
                    const key = `${settings.targetLanguage}:${token.toLowerCase()}`;
                    const vocabEntry = this.vocabulary[key];

                    if (vocabEntry) {
                        if (vocabEntry.status === 'known') {
                            wordSpan.classList.add('yb-word-known');
                        } else {
                            wordSpan.classList.add('yb-word-learning');
                        }
                    } else {
                        wordSpan.classList.add('yb-word-unknown');
                    }

                    // Word click handler
                    wordSpan.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        // Pause video
                        const video = document.querySelector('video');
                        if (video && !video.paused) {
                            video.pause();
                        }
                        // Show popup
                        WordPopup.show(wordSpan, token, original, settings.targetLanguage, settings.nativeLanguage, settings);
                    });

                    originalLine.appendChild(wordSpan);
                } else {
                    originalLine.appendChild(document.createTextNode(token));
                }
                // Add space between words (except for CJK)
                if (!['zh', 'ja'].includes(settings.targetLanguage) && isWord(token)) {
                    originalLine.appendChild(document.createTextNode(' '));
                }
            });

            container.appendChild(originalLine);
        }

        // Translation line
        if (settings.showTranslatedSubtitle && translation) {
            const translationLine = document.createElement('div');
            translationLine.className = 'yb-subtitle-line yb-subtitle-translation';
            translationLine.style.fontSize = `${Math.max(12, settings.fontSize - 2)}px`;
            translationLine.textContent = translation;
            container.appendChild(translationLine);
        }
    },

    /**
     * Update settings
     */
    async updateSettings(newSettings) {
        this.settings = newSettings;
        this.vocabulary = await StorageHelper.getVocabulary();
    },

    /**
     * Cleanup
     */
    destroy() {
        if (this.observer) {
            this.observer.disconnect();
        }
        if (this.subtitleContainer) {
            this.subtitleContainer.remove();
        }
        // Restore YouTube captions
        const captionWindow = document.querySelector('.ytp-caption-window-container');
        if (captionWindow) {
            captionWindow.style.opacity = '';
            captionWindow.style.pointerEvents = '';
        }
    }
};
