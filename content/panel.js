/**
 * Event-driven, virtualized subtitle panel.
 */
const SubtitlePanel = {
    panel: null,
    subtitleList: null,
    isVisible: false,
    activeIndex: -1,

    async loadVocabulary(filter = 'all') {
        const vocabList = this.panel?.querySelector('.yb-vocab-list');
        if (!vocabList) return;

        const settings = await StorageHelper.getSettings();
        const status = filter === 'all' ? null : filter;
        const words = await StorageHelper.getVocabularyByLanguage(settings.targetLanguage, status);

        if (words.length === 0) {
            vocabList.innerHTML = `
                <div class="yb-vocab-empty">
                    <span class="yb-vocab-empty-icon" aria-hidden="true">📚</span>
                    <p>No words yet. Click a subtitle word to add it.</p>
                </div>
            `;
            return;
        }

        vocabList.innerHTML = words.map(entry => `
            <div class="yb-vocab-item ${entry.status}">
                <div class="yb-vocab-word">${this.escapeHtml(entry.word)}</div>
                <div class="yb-vocab-definition">${this.escapeHtml(entry.definition || '')}</div>
                <span class="yb-vocab-status-badge ${entry.status}">
                    ${entry.status === 'known' ? '✓ Mastered' : '📖 Learning'}
                </span>
            </div>
        `).join('');
    },

    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainder = Math.floor(seconds % 60);
        return `${minutes}:${remainder.toString().padStart(2, '0')}`;
    },

    escapeHtml(text) {
        const element = document.createElement('div');
        element.textContent = String(text || '');
        return element.innerHTML;
    }
};

// Accessible panel state and behavior.
Object.assign(SubtitlePanel, {
    captions: [],
    indexToPosition: new Map(),
    generation: null,
    activeIndex: -1,
    displayMode: 'bilingual',
    rowHeight: 94,
    followActive: true,
    renderQueued: false,
    _initialized: false,
    _eventsBound: false,
    _playerControlsTimer: null,
    _programmaticScroll: false,

    init() {
        if (!this.panel?.isConnected) this.createPanel();
        this.bindDocumentEvents();
        this.addPlayerControls();
        this.updateDisplayMode(this.displayMode);
        this.handleFullscreenChange();
        this._initialized = true;
    },

    createPanel() {
        document.getElementById('yt-bilingual-panel')?.remove();
        this.panel = document.createElement('aside');
        this.panel.id = 'yt-bilingual-panel';
        this.panel.className = 'yb-panel';
        this.panel.setAttribute('aria-label', 'Bilingual subtitle panel');
        this.panel.setAttribute('aria-hidden', 'true');
        this.panel.innerHTML = `
          <div class="yb-panel-header">
            <div>
              <h3 class="yb-panel-title"><span aria-hidden="true">CC</span> Subtitles</h3>
              <div class="yb-panel-status" role="status">Waiting</div>
            </div>
            <div class="yb-panel-controls">
              <button type="button" class="yb-panel-btn yb-panel-download-log" aria-label="Download translation log" title="Download translation log">DL</button>
              <button type="button" class="yb-panel-btn yb-panel-vocab-btn" aria-label="Open vocabulary" title="Vocabulary">V</button>
              <button type="button" class="yb-panel-btn yb-panel-close" aria-label="Close subtitle panel" title="Close panel">X</button>
            </div>
          </div>
          <div class="yb-panel-mode" role="group" aria-label="Subtitle display">
            <button type="button" data-mode="original">Original</button>
            <button type="button" data-mode="bilingual">Bilingual</button>
            <button type="button" data-mode="translated">Translation</button>
          </div>
          <div class="yb-panel-tabs" role="tablist" aria-label="Panel content">
            <button type="button" id="yb-tab-subtitles" class="yb-panel-tab active" role="tab" aria-selected="true" aria-controls="yb-panel-subtitles" data-tab="subtitles">Subtitles</button>
            <button type="button" id="yb-tab-vocabulary" class="yb-panel-tab" role="tab" aria-selected="false" aria-controls="yb-panel-vocabulary" data-tab="vocabulary">Vocabulary</button>
          </div>
          <div class="yb-panel-content">
            <div id="yb-panel-subtitles" class="yb-panel-tab-content yb-subtitles-tab active" role="tabpanel" aria-labelledby="yb-tab-subtitles" tabindex="0" data-tab="subtitles">
              <div class="yb-panel-empty" role="status">Waiting for captions...</div>
              <div class="yb-panel-subtitle-list" role="list"></div>
              <button type="button" class="yb-panel-follow" hidden>Follow playback</button>
            </div>
            <div id="yb-panel-vocabulary" class="yb-panel-tab-content yb-vocabulary-tab" role="tabpanel" aria-labelledby="yb-tab-vocabulary" tabindex="0" data-tab="vocabulary">
              <div class="yb-vocab-filter" role="group" aria-label="Vocabulary filter">
                <button type="button" class="yb-vocab-filter-btn active" data-filter="all" aria-pressed="true">All</button>
                <button type="button" class="yb-vocab-filter-btn" data-filter="learning" aria-pressed="false">Learning</button>
                <button type="button" class="yb-vocab-filter-btn" data-filter="known" aria-pressed="false">Mastered</button>
              </div>
              <div class="yb-vocab-list"></div>
            </div>
          </div>
        `;
        document.body.appendChild(this.panel);
        this.subtitleList = this.panel.querySelector('.yb-panel-subtitle-list');
        this.subtitleViewport = this.panel.querySelector('.yb-subtitles-tab');
        this.emptyState = this.panel.querySelector('.yb-panel-empty');
        this.followButton = this.panel.querySelector('.yb-panel-follow');

        this.panel.querySelector('.yb-panel-close').addEventListener('click', () => this.hide());
        this.panel.querySelector('.yb-panel-download-log').addEventListener('click', () => SubtitleManager.downloadLog());
        this.panel.querySelector('.yb-panel-vocab-btn').addEventListener('click', () => this.switchTab('vocabulary'));

        this.panel.querySelectorAll('.yb-panel-tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
            tab.addEventListener('keydown', event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                this.switchTab(tab.dataset.tab === 'subtitles' ? 'vocabulary' : 'subtitles', true);
            });
        });
        this.panel.querySelectorAll('.yb-panel-mode button').forEach(button => {
            button.addEventListener('click', () => this.setDisplayMode(button.dataset.mode));
        });
        this.panel.querySelectorAll('.yb-vocab-filter-btn').forEach(button => {
            button.addEventListener('click', () => {
                this.panel.querySelectorAll('.yb-vocab-filter-btn').forEach(item => {
                    const selected = item === button;
                    item.classList.toggle('active', selected);
                    item.setAttribute('aria-pressed', String(selected));
                });
                this.loadVocabulary(button.dataset.filter);
            });
        });

        this.subtitleList.addEventListener('click', event => {
            const entry = event.target.closest('.yb-panel-subtitle-entry');
            if (!entry) return;
            const position = this.indexToPosition.get(Number(entry.dataset.index));
            const caption = this.captions[position];
            const video = document.querySelector('video');
            if (caption && video) {
                video.currentTime = caption.startMs / 1000;
                video.play().catch(() => {});
            }
        });
        this.subtitleViewport.addEventListener('scroll', event => {
            if (event.isTrusted && !this._programmaticScroll) {
                this.followActive = false;
                this.followButton.hidden = false;
            }
            this.queueVirtualRender();
        }, { passive: true });
        this.followButton.addEventListener('click', () => {
            this.followActive = true;
            this.followButton.hidden = true;
            this.scrollActiveIntoView();
        });

        this.renderVirtualWindow(true);
    },

    bindDocumentEvents() {
        if (this._eventsBound) return;
        this._eventsBound = true;

        document.addEventListener('yb-captions-ready', event => {
            const detail = event.detail || {};
            const captions = Array.isArray(detail) ? detail : (detail.captions || []);
            this.setCaptions(captions, { generation: detail.generation });
        });
        document.addEventListener('yb-caption-active', event => {
            const detail = event.detail || {};
            if (!this.acceptGeneration(detail.generation)) return;
            this.setActive(Number(detail.index));
        });
        document.addEventListener('yb-caption-translation', event => {
            const detail = event.detail || {};
            if (!this.acceptGeneration(detail.generation)) return;
            this.updateSubtitleTranslation(Number(detail.index), detail.translation || '', detail.status, detail.error);
        });
        document.addEventListener('yb-vocabulary-updated', () => {
            if (this.panel?.querySelector('.yb-vocabulary-tab.active')) this.loadVocabulary();
        });
        document.addEventListener('fullscreenchange', () => this.handleFullscreenChange());
    },

    acceptGeneration(generation) {
        return generation == null || this.generation == null || generation === this.generation;
    },

    normalizeCaption(caption, position) {
        return {
            index: Number.isFinite(caption.index) ? caption.index : position,
            id: caption.id || '',
            startMs: Number(caption.startMs ?? caption.startTime * 1000) || 0,
            endMs: Number(caption.endMs ?? caption.endTime * 1000) || 0,
            text: String(caption.text || caption.original || ''),
            translation: caption.translation && caption.translation !== '__pending__' ? String(caption.translation) : '',
            status: caption.status || (caption.translation === '__pending__' ? 'pending' : ''),
            error: caption.error || ''
        };
    },

    setCaptions(captions, meta = {}) {
        if (!Array.isArray(captions)) return;
        this.generation = meta.generation ?? this.generation;
        this.captions = captions.map((caption, position) => this.normalizeCaption(caption, position));
        this.indexToPosition = new Map(this.captions.map((caption, position) => [caption.index, position]));
        this.activeIndex = -1;
        this.followActive = true;
        if (this.followButton) this.followButton.hidden = true;
        if (this.subtitleViewport) this.subtitleViewport.scrollTop = 0;
        this.setEmptyMessage(this.captions.length ? '' : 'Waiting for captions...');
        this.renderVirtualWindow(true);
        this.setStatus({
            state: this.captions.length ? 'ready' : 'waiting',
            message: this.captions.length ? `${this.captions.length} captions` : 'Waiting'
        });
    },

    setEmptyMessage(message) {
        if (!this.emptyState) return;
        this.emptyState.textContent = message;
        this.emptyState.hidden = !message;
        if (this.subtitleList) this.subtitleList.hidden = Boolean(message);
    },

    queueVirtualRender() {
        if (this.renderQueued) return;
        this.renderQueued = true;
        requestAnimationFrame(() => {
            this.renderQueued = false;
            this.renderVirtualWindow();
        });
    },

    renderVirtualWindow(force = false) {
        if (!this.subtitleList || !this.subtitleViewport) return;
        if (!this.captions.length) {
            this.subtitleList.replaceChildren();
            this.subtitleList.style.height = '0px';
            return;
        }

        const viewportHeight = this.subtitleViewport.clientHeight || 600;
        const start = Math.max(0, Math.floor(this.subtitleViewport.scrollTop / this.rowHeight) - 6);
        const end = Math.min(this.captions.length, Math.ceil((this.subtitleViewport.scrollTop + viewportHeight) / this.rowHeight) + 6);
        const signature = `${start}:${end}:${this.activeIndex}:${this.displayMode}`;
        if (!force && this.subtitleList.dataset.window === signature) return;
        this.subtitleList.dataset.window = signature;
        this.subtitleList.style.height = `${this.captions.length * this.rowHeight}px`;

        const fragment = document.createDocumentFragment();
        for (let position = start; position < end; position++) {
            fragment.appendChild(this.createCaptionEntry(this.captions[position], position));
        }
        this.subtitleList.replaceChildren(fragment);
    },

    createCaptionEntry(caption, position) {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = 'yb-panel-subtitle-entry';
        entry.dataset.index = String(caption.index);
        entry.dataset.position = String(position);
        entry.setAttribute('role', 'listitem');
        entry.setAttribute('aria-label', `${this.formatTime(caption.startMs / 1000)}. ${caption.text}`);
        entry.classList.toggle('active', caption.index === this.activeIndex);
        entry.style.transform = `translateY(${position * this.rowHeight}px)`;

        const time = document.createElement('span');
        time.className = 'yb-panel-sub-time';
        time.textContent = this.formatTime(caption.startMs / 1000);
        const original = document.createElement('span');
        original.className = 'yb-panel-sub-original';
        original.dir = 'auto';
        original.textContent = caption.text;
        const translated = document.createElement('span');
        translated.className = 'yb-panel-sub-translated';
        translated.dir = 'auto';
        translated.dataset.status = caption.status || '';
        translated.textContent = caption.status === 'pending'
            ? 'Translating...'
            : (caption.status === 'error' ? 'Translation unavailable' : caption.translation);

        entry.append(time, original, translated);
        return entry;
    },

    updateSubtitleTranslation(index, translated, status = '', error = '') {
        const position = this.indexToPosition.get(index);
        if (position == null) return;
        const caption = this.captions[position];
        caption.translation = translated || '';
        caption.status = status || (translated ? 'ready' : '');
        caption.error = error || '';
        this.renderVirtualWindow(true);
    },

    setActive(index) {
        if (!Number.isFinite(index) || this.activeIndex === index) return;
        this.activeIndex = index;
        this.renderVirtualWindow(true);
        if (this.followActive && this.isVisible) this.scrollActiveIntoView();
    },

    scrollActiveIntoView() {
        const position = this.indexToPosition.get(this.activeIndex);
        if (position == null || !this.subtitleViewport) return;
        const target = Math.max(0, position * this.rowHeight - (this.subtitleViewport.clientHeight - this.rowHeight) / 2);
        this._programmaticScroll = true;
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        this.subtitleViewport.scrollTo({ top: target, behavior: reducedMotion ? 'auto' : 'smooth' });
        setTimeout(() => { this._programmaticScroll = false; }, reducedMotion ? 0 : 350);
    },

    switchTab(name, focus = false) {
        this.panel?.querySelectorAll('.yb-panel-tab').forEach(tab => {
            const selected = tab.dataset.tab === name;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
            if (selected && focus) tab.focus();
        });
        this.panel?.querySelectorAll('.yb-panel-tab-content').forEach(content => {
            content.classList.toggle('active', content.dataset.tab === name);
        });
        if (name === 'vocabulary') this.loadVocabulary();
    },

    addPlayerControls() {
        if (this._playerControlsTimer) return;
        const mount = () => {
            const controls = document.querySelector('.ytp-right-controls');
            if (!controls) return;

            if (!controls.querySelector('.yb-display-mode-btn')) {
                const modeButton = document.createElement('button');
                modeButton.type = 'button';
                modeButton.className = 'ytp-button yb-display-mode-btn';
                modeButton.setAttribute('aria-label', 'Change subtitle display mode');
                modeButton.innerHTML = '<span class="yb-mode-glyph" aria-hidden="true">B</span>';
                modeButton.addEventListener('click', () => this.cycleDisplayMode());
                controls.insertBefore(modeButton, controls.firstChild);
            }
            if (!controls.querySelector('.yb-toggle-panel-btn')) {
                const panelButton = document.createElement('button');
                panelButton.type = 'button';
                panelButton.className = 'ytp-button yb-toggle-panel-btn';
                panelButton.setAttribute('aria-label', 'Open subtitle panel');
                panelButton.setAttribute('aria-expanded', String(this.isVisible));
                panelButton.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>';
                panelButton.addEventListener('click', () => this.toggle());
                controls.insertBefore(panelButton, controls.firstChild);
            }
            this.updateDisplayMode(this.displayMode);
        };
        mount();
        this._playerControlsTimer = setInterval(mount, 1000);
    },

    suspend() {
        if (this._playerControlsTimer) {
            clearInterval(this._playerControlsTimer);
            this._playerControlsTimer = null;
        }
        document.querySelectorAll('.yb-display-mode-btn, .yb-toggle-panel-btn').forEach(button => button.remove());
        this.hide(false);
        this._initialized = false;
    },

    async setDisplayMode(mode) {
        if (!['original', 'bilingual', 'translated'].includes(mode)) return;
        const previous = this.displayMode;
        this.updateDisplayMode(mode);
        try {
            await StorageHelper.updateSettings({ subtitleDisplayMode: mode });
        } catch (error) {
            this.updateDisplayMode(previous);
            this.setStatus({ state: 'error', message: `Could not save display mode: ${error.message}` });
            throw error;
        }
    },

    cycleDisplayMode() {
        const modes = ['original', 'bilingual', 'translated'];
        const current = Math.max(0, modes.indexOf(this.displayMode));
        this.setDisplayMode(modes[(current + 1) % modes.length]).catch(() => undefined);
    },

    updateDisplayMode(mode = 'bilingual') {
        this.displayMode = ['original', 'bilingual', 'translated'].includes(mode) ? mode : 'bilingual';
        if (this.panel) this.panel.dataset.displayMode = this.displayMode;
        this.panel?.querySelectorAll('.yb-panel-mode button').forEach(button => {
            const active = button.dataset.mode === this.displayMode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        const modeButton = document.querySelector('.yb-display-mode-btn');
        if (modeButton) {
            const labels = { original: 'Original subtitles', bilingual: 'Bilingual subtitles', translated: 'Translated subtitles' };
            const glyphs = { original: 'O', bilingual: 'B', translated: 'T' };
            modeButton.title = labels[this.displayMode];
            modeButton.setAttribute('aria-label', `${labels[this.displayMode]}. Click to change mode.`);
            modeButton.querySelector('.yb-mode-glyph').textContent = glyphs[this.displayMode];
        }
        this.renderVirtualWindow(true);
    },

    toggle(persist = true) {
        this.isVisible ? this.hide(persist) : this.show(persist);
    },

    show(persist = true) {
        if (!this.panel) this.init();
        this.isVisible = true;
        this.panel.classList.add('visible');
        this.panel.setAttribute('aria-hidden', 'false');
        document.querySelector('.yb-toggle-panel-btn')?.setAttribute('aria-expanded', 'true');
        if (persist) {
            StorageHelper.updateSettings({ showPanel: true }).catch(error => {
                this.hide(false);
                this.setStatus({ state: 'error', message: `Could not save panel preference: ${error.message}` });
            });
        }
        this.renderVirtualWindow(true);
        if (this.followActive) this.scrollActiveIntoView();
    },

    hide(persist = true) {
        this.isVisible = false;
        this.panel?.classList.remove('visible');
        this.panel?.setAttribute('aria-hidden', 'true');
        document.querySelector('.yb-toggle-panel-btn')?.setAttribute('aria-expanded', 'false');
        if (persist) {
            StorageHelper.updateSettings({ showPanel: false }).catch(error => {
                this.show(false);
                this.setStatus({ state: 'error', message: `Could not save panel preference: ${error.message}` });
            });
        }
    },

    clear(message = 'Waiting for captions...') {
        this.captions = [];
        this.indexToPosition = new Map();
        this.generation = null;
        this.activeIndex = -1;
        this.setEmptyMessage(message);
        this.renderVirtualWindow(true);
        this.setStatus({ state: 'waiting', message });
    },

    setStatus(status = {}) {
        const element = this.panel?.querySelector('.yb-panel-status');
        if (!element) return;
        element.dataset.state = status.state || 'waiting';
        element.textContent = status.message || 'Waiting';
    },

    handleFullscreenChange() {
        if (!this.panel) return;
        const fullscreenRoot = document.fullscreenElement;
        if (fullscreenRoot) {
            fullscreenRoot.appendChild(this.panel);
            this.panel.classList.add('yb-panel-fullscreen');
        } else {
            document.body.appendChild(this.panel);
            this.panel.classList.remove('yb-panel-fullscreen');
        }
    }
});
