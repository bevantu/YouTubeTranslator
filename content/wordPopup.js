/**
 * Word Popup Component
 * Shows word definition when clicking on a subtitle word
 */
const WordPopup = {
    popup: null,
    currentWord: null,

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
        <button class="yb-popup-close" title="Close">✕</button>
      </div>
      <div class="yb-popup-body">
        <div class="yb-popup-pos"></div>
        <div class="yb-popup-translation"></div>
        <div class="yb-popup-explanation"></div>
        <div class="yb-popup-loading">
          <div class="yb-spinner"></div>
          <span>Loading definition...</span>
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

        const popup = this.popup;
        popup.querySelector('.yb-popup-word').textContent = word;
        popup.querySelector('.yb-popup-pronunciation').textContent = '';
        popup.querySelector('.yb-popup-pos').textContent = '';
        popup.querySelector('.yb-popup-translation').textContent = '';
        popup.querySelector('.yb-popup-explanation').textContent = '';
        popup.querySelector('.yb-popup-loading').style.display = 'flex';
        popup.querySelector('.yb-popup-body .yb-popup-pos').style.display = 'none';
        popup.querySelector('.yb-popup-body .yb-popup-translation').style.display = 'none';
        popup.querySelector('.yb-popup-body .yb-popup-explanation').style.display = 'none';

        // Position popup near the word
        const rect = wordElement.getBoundingClientRect();
        const popupWidth = 320;
        const popupHeight = 250;

        let left = rect.left + rect.width / 2 - popupWidth / 2;
        let top = rect.top - popupHeight - 10;

        // Keep popup within viewport
        if (left < 10) left = 10;
        if (left + popupWidth > window.innerWidth - 10) left = window.innerWidth - popupWidth - 10;
        if (top < 10) top = rect.bottom + 10;

        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
        popup.style.display = 'block';

        // Update word status buttons
        const wordStatus = await StorageHelper.getWordStatus(word, targetLang);
        this.updateButtons(wordStatus?.status);

        // Get definition
        try {
            const definition = await TranslatorService.getWordDefinition(word, context, targetLang, nativeLang, settings);

            popup.querySelector('.yb-popup-loading').style.display = 'none';

            if (definition.pronunciation) {
                popup.querySelector('.yb-popup-pronunciation').textContent = `[${definition.pronunciation}]`;
            }
            if (definition.pos) {
                popup.querySelector('.yb-popup-pos').textContent = definition.pos;
                popup.querySelector('.yb-popup-pos').style.display = 'block';
            }
            if (definition.translation) {
                popup.querySelector('.yb-popup-translation').textContent = definition.translation;
                popup.querySelector('.yb-popup-translation').style.display = 'block';
            }
            if (definition.explanation) {
                popup.querySelector('.yb-popup-explanation').textContent = definition.explanation;
                popup.querySelector('.yb-popup-explanation').style.display = 'block';
            }

            // Save definition
            if (definition.translation && wordStatus) {
                await StorageHelper.saveWord(word, wordStatus.status, definition.translation, targetLang);
            }
        } catch (err) {
            popup.querySelector('.yb-popup-loading').style.display = 'none';
            popup.querySelector('.yb-popup-translation').textContent = '(Failed to load definition)';
            popup.querySelector('.yb-popup-translation').style.display = 'block';
        }
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

        const definition = this.popup.querySelector('.yb-popup-translation').textContent || '';
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
     * Hide popup
     */
    hide() {
        if (this.popup) {
            this.popup.style.display = 'none';
        }
        this.currentWord = null;
    }
};
