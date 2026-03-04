/**
 * Word Popup Component
 * Shows word definition when clicking on a subtitle word.
 * Two sections:
 *   1. Dictionary (instant, from free dictionaryapi.dev)
 *   2. AI Context (slower, LLM-powered contextual explanation)
 */
const WordPopup = {
    popup: null,
    currentWord: null,
    currentLang: null,
    currentWordElement: null,

    /**
     * Initialize the popup
     */
    init() {
        this.createPopup();
    },

    /**
     * Create popup DOM element
     */
    createPopup() {
        if (this.popup) return;

        this.popup = document.createElement('div');
        this.popup.id = 'yt-bilingual-word-popup';
        this.popup.className = 'yt-bilingual-popup';
        this.popup.innerHTML = `
      <div class="yb-popup-header">
        <span class="yb-popup-word"></span>
        <span class="yb-popup-pronunciation"></span>
        <button class="yb-popup-audio-btn" title="Play pronunciation" style="display:none;">🔊</button>
        <button class="yb-popup-close" title="Close">✕</button>
      </div>

      <!-- Section 1: Dictionary definitions (instant) -->
      <div class="yb-popup-dict">
        <div class="yb-popup-dict-loading">
          <div class="yb-spinner-sm"></div>
          <span>Loading dictionary...</span>
        </div>
        <div class="yb-popup-dict-content" style="display:none;"></div>
        <div class="yb-popup-dict-empty" style="display:none;">
          <span style="opacity: 0.5;">No dictionary entry found</span>
        </div>
      </div>

      <div class="yb-popup-divider"></div>

      <!-- Section 2: AI contextual definition (slower) -->
      <div class="yb-popup-ai">
        <div class="yb-popup-ai-label">✨ AI Contextual Analysis</div>
        <div class="yb-popup-ai-loading">
          <div class="yb-spinner"></div>
          <span>Analyzing context...</span>
        </div>
        <div class="yb-popup-ai-content" style="display:none;">
          <div class="yb-popup-ai-translation"></div>
          <div class="yb-popup-ai-explanation"></div>
        </div>
      </div>

      <div class="yb-popup-actions">
        <button class="yb-btn yb-btn-known" data-status="known">
          <span class="yb-btn-icon">✓</span> Mastered
        </button>
        <button class="yb-btn yb-btn-learning" data-status="learning">
          <span class="yb-btn-icon">📖</span> Learning
        </button>
      </div>
    `;

        document.body.appendChild(this.popup);

        // Event listeners
        this.popup.querySelector('.yb-popup-close').addEventListener('click', () => this.hide());
        this.popup.querySelector('.yb-btn-known').addEventListener('click', () => this.markWord('known'));
        this.popup.querySelector('.yb-btn-learning').addEventListener('click', () => this.markWord('learning'));

        // Audio button
        this.popup.querySelector('.yb-popup-audio-btn').addEventListener('click', () => {
            if (this._audioUrl) {
                const audio = new Audio(this._audioUrl);
                audio.play().catch(() => { });
            }
        });

        // Close on click outside
        document.addEventListener('click', (e) => {
            if (this.popup && !this.popup.contains(e.target) && !e.target.classList.contains('yb-word')) {
                this.hide();
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hide();
        });
    },

    /**
     * Show popup for a word
     */
    async show(wordElement, word, context, targetLang, nativeLang, settings) {
        this.init();
        this.currentWord = word;
        this.currentLang = targetLang;
        this._audioUrl = null;

        const popup = this.popup;

        // Reset header
        popup.querySelector('.yb-popup-word').textContent = word;
        popup.querySelector('.yb-popup-pronunciation').textContent = '';
        popup.querySelector('.yb-popup-audio-btn').style.display = 'none';

        // Reset dict section
        popup.querySelector('.yb-popup-dict-loading').style.display = 'flex';
        popup.querySelector('.yb-popup-dict-content').style.display = 'none';
        popup.querySelector('.yb-popup-dict-content').innerHTML = '';
        popup.querySelector('.yb-popup-dict-empty').style.display = 'none';

        // Reset AI section
        popup.querySelector('.yb-popup-ai-loading').style.display = 'flex';
        popup.querySelector('.yb-popup-ai-content').style.display = 'none';
        popup.querySelector('.yb-popup-ai-translation').textContent = '';
        popup.querySelector('.yb-popup-ai-explanation').textContent = '';

        // Show popup and position
        popup.style.display = 'block';
        this.currentWordElement = wordElement;
        this.repositionPopup();

        // Update word status buttons
        const wordStatus = await StorageHelper.getWordStatus(word, targetLang);
        const isKnown = await StorageHelper.isWordKnown(word, targetLang, settings.proficiencyLevel);
        let effectiveStatus = wordStatus ? wordStatus.status : (isKnown ? 'known' : 'unknown');
        this.updateButtons(effectiveStatus);

        // Fire BOTH requests in parallel
        this.fetchDictionary(word, nativeLang);
        this.fetchAIDefinition(word, context, targetLang, nativeLang, settings, wordStatus);
    },

    /**
     * Fetch dictionary definition + quick translation (instant)
     */
    async fetchDictionary(word, nativeLang) {
        const popup = this.popup;
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'dictLookup',
                word: word,
                nativeLang: nativeLang
            });

            popup.querySelector('.yb-popup-dict-loading').style.display = 'none';

            if (response?.success && response.result) {
                const dict = response.result;

                // Set phonetic in header
                if (dict.phonetic) {
                    popup.querySelector('.yb-popup-pronunciation').textContent = dict.phonetic;
                }

                // Set audio button
                if (dict.audioUrl) {
                    this._audioUrl = dict.audioUrl;
                    popup.querySelector('.yb-popup-audio-btn').style.display = 'inline-block';
                }

                // Show quick translation (Chinese/native language)
                const contentEl = popup.querySelector('.yb-popup-dict-content');
                if (dict.quickTranslation) {
                    contentEl.innerHTML = `<div class="yb-dict-translation">${dict.quickTranslation}</div>`;
                    contentEl.style.display = 'block';
                } else {
                    popup.querySelector('.yb-popup-dict-empty').style.display = 'block';
                }
            } else {
                popup.querySelector('.yb-popup-dict-empty').style.display = 'block';
            }
        } catch (err) {
            popup.querySelector('.yb-popup-dict-loading').style.display = 'none';
            popup.querySelector('.yb-popup-dict-empty').style.display = 'block';
        }
        this.repositionPopup();
    },

    /**
     * Fetch AI contextual definition (slower)
     */
    async fetchAIDefinition(word, context, targetLang, nativeLang, settings, wordStatus) {
        const popup = this.popup;
        try {
            const definition = await TranslatorService.getWordDefinition(
                word, context, targetLang, nativeLang, settings
            );

            popup.querySelector('.yb-popup-ai-loading').style.display = 'none';
            const contentEl = popup.querySelector('.yb-popup-ai-content');

            if (definition.translation) {
                popup.querySelector('.yb-popup-ai-translation').textContent = definition.translation;
            }
            if (definition.explanation) {
                popup.querySelector('.yb-popup-ai-explanation').textContent = definition.explanation;
            }
            contentEl.style.display = 'block';

            // Save definition
            if (definition.translation && wordStatus) {
                await StorageHelper.saveWord(word, wordStatus.status, definition.translation, this.currentLang);
            }
        } catch (err) {
            popup.querySelector('.yb-popup-ai-loading').style.display = 'none';
            const contentEl = popup.querySelector('.yb-popup-ai-content');
            popup.querySelector('.yb-popup-ai-translation').textContent = '(Failed to load AI definition)';
            contentEl.style.display = 'block';
        }
        this.repositionPopup();
    },

    /**
     * Update button states
     */
    updateButtons(status) {
        const knownBtn = this.popup.querySelector('.yb-btn-known');
        const learningBtn = this.popup.querySelector('.yb-btn-learning');

        knownBtn.classList.toggle('active', status === 'known');
        learningBtn.classList.toggle('active', status === 'learning');
    },

    /**
     * Mark word with status
     */
    async markWord(status) {
        if (!this.currentWord) return;

        const definition = this.popup.querySelector('.yb-popup-ai-translation').textContent || '';
        await StorageHelper.saveWord(this.currentWord, status, definition, this.currentLang);
        this.updateButtons(status);

        // Update word highlighting in subtitles
        document.querySelectorAll('.yb-word').forEach(el => {
            if (el.textContent.toLowerCase() === this.currentWord.toLowerCase()) {
                el.classList.remove('yb-word-known', 'yb-word-unknown', 'yb-word-learning');
                el.classList.add(status === 'known' ? 'yb-word-known' : 'yb-word-learning');
            }
        });

        // Dispatch event for panel update
        document.dispatchEvent(new CustomEvent('yb-vocabulary-updated'));
    },

    /**
     * Reposition popup relative to the current word element.
     */
    repositionPopup() {
        if (!this.popup || !this.currentWordElement) return;

        const popup = this.popup;
        const rect = this.currentWordElement.getBoundingClientRect();
        const actualWidth = popup.offsetWidth || 320;
        const actualHeight = popup.offsetHeight || 100;

        let left = rect.left + rect.width / 2 - actualWidth / 2;
        let top = rect.top - actualHeight - 10;

        if (left < 10) left = 10;
        if (left + actualWidth > window.innerWidth - 10) left = window.innerWidth - actualWidth - 10;

        if (top < 10) {
            top = rect.bottom + 10;
        }

        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
    },

    /**
     * Hide popup
     */
    hide() {
        if (this.popup) {
            this.popup.style.display = 'none';
        }
        this.currentWord = null;
        this.currentWordElement = null;
        this._audioUrl = null;
    }
};
