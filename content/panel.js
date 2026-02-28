/**
 * Side Panel - Subtitle list panel on the right side of the video
 */
const SubtitlePanel = {
    panel: null,
    subtitleList: null,
    isVisible: false,
    subtitles: [],
    activeIndex: -1,

    /**
     * Initialize the side panel
     */
    init() {
        this.createPanel();
        this.addToggleButton();
    },

    /**
     * Create the side panel DOM
     */
    createPanel() {
        if (this.panel) return;

        this.panel = document.createElement('div');
        this.panel.id = 'yt-bilingual-panel';
        this.panel.className = 'yb-panel';
        this.panel.innerHTML = `
      <div class="yb-panel-header">
        <h3 class="yb-panel-title">
          <span class="yb-panel-icon">📝</span> Subtitles
        </h3>
        <div class="yb-panel-controls">
          <button class="yb-panel-btn yb-panel-vocab-btn" title="Vocabulary">
            <span>📚</span>
          </button>
          <button class="yb-panel-btn yb-panel-close" title="Close panel">
            <span>✕</span>
          </button>
        </div>
      </div>
      <div class="yb-panel-tabs">
        <button class="yb-panel-tab active" data-tab="subtitles">Subtitles</button>
        <button class="yb-panel-tab" data-tab="vocabulary">Vocabulary</button>
      </div>
      <div class="yb-panel-content">
        <div class="yb-panel-tab-content yb-subtitles-tab active" data-tab="subtitles">
          <div class="yb-panel-subtitle-list"></div>
        </div>
        <div class="yb-panel-tab-content yb-vocabulary-tab" data-tab="vocabulary">
          <div class="yb-vocab-filter">
            <button class="yb-vocab-filter-btn active" data-filter="all">All</button>
            <button class="yb-vocab-filter-btn" data-filter="learning">Learning</button>
            <button class="yb-vocab-filter-btn" data-filter="known">Mastered</button>
          </div>
          <div class="yb-vocab-list"></div>
        </div>
      </div>
    `;

        // Insert next to video
        const secondary = document.querySelector('#secondary');
        if (secondary) {
            secondary.parentElement.insertBefore(this.panel, secondary);
        } else {
            document.body.appendChild(this.panel);
        }

        this.subtitleList = this.panel.querySelector('.yb-panel-subtitle-list');

        // Event listeners
        this.panel.querySelector('.yb-panel-close').addEventListener('click', () => this.toggle());

        // Tab switching
        this.panel.querySelectorAll('.yb-panel-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.panel.querySelectorAll('.yb-panel-tab').forEach(t => t.classList.remove('active'));
                this.panel.querySelectorAll('.yb-panel-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                this.panel.querySelector(`.yb-panel-tab-content[data-tab="${tab.dataset.tab}"]`).classList.add('active');

                if (tab.dataset.tab === 'vocabulary') {
                    this.loadVocabulary();
                }
            });
        });

        // Vocab button
        this.panel.querySelector('.yb-panel-vocab-btn').addEventListener('click', () => {
            this.panel.querySelector('.yb-panel-tab[data-tab="vocabulary"]').click();
        });

        // Vocabulary filter
        this.panel.querySelectorAll('.yb-vocab-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.panel.querySelectorAll('.yb-vocab-filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.loadVocabulary(btn.dataset.filter);
            });
        });

        // Listen for vocabulary updates
        document.addEventListener('yb-vocabulary-updated', () => {
            this.loadVocabulary();
        });
    },

    /**
     * Add toggle button to YouTube player
     */
    addToggleButton() {
        const checkForControls = setInterval(() => {
            const controls = document.querySelector('.ytp-right-controls');
            if (controls && !document.querySelector('.yb-toggle-panel-btn')) {
                const btn = document.createElement('button');
                btn.className = 'ytp-button yb-toggle-panel-btn';
                btn.title = 'Toggle Subtitle Panel';
                btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="white">
          <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
        </svg>`;
                btn.addEventListener('click', () => this.toggle());
                controls.insertBefore(btn, controls.firstChild);
                clearInterval(checkForControls);
            }
        }, 1000);
    },

    /**
     * Toggle panel visibility
     */
    toggle() {
        this.isVisible = !this.isVisible;
        if (this.panel) {
            this.panel.classList.toggle('visible', this.isVisible);
        }
        // Adjust video width
        const primary = document.querySelector('#primary');
        if (primary) {
            primary.style.maxWidth = this.isVisible ? 'calc(100% - 380px)' : '';
        }
    },

    /**
     * Show the panel
     */
    show() {
        if (!this.isVisible) {
            this.toggle();
        }
    },

    /**
     * Add a subtitle entry to the panel
     */
    addSubtitle(original, translated, startTime, index) {
        if (!this.subtitleList) return;

        const existing = this.subtitleList.querySelector(`[data-index="${index}"]`);
        if (existing) return; // Already exists

        const entry = document.createElement('div');
        entry.className = 'yb-panel-subtitle-entry';
        entry.dataset.index = index;
        entry.dataset.time = startTime;

        const timeStr = this.formatTime(startTime);
        entry.innerHTML = `
      <div class="yb-panel-sub-time">${timeStr}</div>
      <div class="yb-panel-sub-original">${this.escapeHtml(original)}</div>
      ${translated ? `<div class="yb-panel-sub-translated">${this.escapeHtml(translated)}</div>` : ''}
    `;

        // Click to seek
        entry.addEventListener('click', () => {
            const video = document.querySelector('video');
            if (video) {
                video.currentTime = startTime;
                video.play();
            }
        });

        this.subtitleList.appendChild(entry);
        this.subtitles.push({ original, translated, startTime, index });
    },

    /**
     * Update translation for a subtitle
     */
    updateSubtitleTranslation(index, translated) {
        const entry = this.subtitleList?.querySelector(`[data-index="${index}"]`);
        if (entry) {
            let transEl = entry.querySelector('.yb-panel-sub-translated');
            if (!transEl) {
                transEl = document.createElement('div');
                transEl.className = 'yb-panel-sub-translated';
                entry.appendChild(transEl);
            }
            transEl.textContent = translated;
        }
    },

    /**
     * Set active subtitle
     */
    setActive(index) {
        if (this.activeIndex === index) return;
        this.activeIndex = index;

        if (!this.subtitleList) return;

        this.subtitleList.querySelectorAll('.yb-panel-subtitle-entry').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.index) === index);
        });

        // Scroll to active
        const activeEl = this.subtitleList.querySelector('.yb-panel-subtitle-entry.active');
        if (activeEl) {
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    },

    /**
     * Clear all subtitles
     */
    clear() {
        if (this.subtitleList) {
            this.subtitleList.innerHTML = '';
        }
        this.subtitles = [];
        this.activeIndex = -1;
    },

    /**
     * Load vocabulary list
     */
    async loadVocabulary(filter = 'all') {
        const vocabList = this.panel?.querySelector('.yb-vocab-list');
        if (!vocabList) return;

        const settings = await StorageHelper.getSettings();
        const status = filter === 'all' ? null : filter;
        const words = await StorageHelper.getVocabularyByLanguage(settings.targetLanguage, status);

        if (words.length === 0) {
            vocabList.innerHTML = `
        <div class="yb-vocab-empty">
          <span class="yb-vocab-empty-icon">📚</span>
          <p>No words yet. Click on words in subtitles to add them!</p>
        </div>
      `;
            return;
        }

        vocabList.innerHTML = words.map(entry => `
      <div class="yb-vocab-item ${entry.status}">
        <div class="yb-vocab-word">${this.escapeHtml(entry.word)}</div>
        <div class="yb-vocab-definition">${this.escapeHtml(entry.definition || '')}</div>
        <span class="yb-vocab-status-badge ${entry.status}">${entry.status === 'known' ? '✓ Mastered' : '📖 Learning'}</span>
      </div>
    `).join('');
    },

    /**
     * Format time in MM:SS
     */
    formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    },

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
