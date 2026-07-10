/**
 * Chrome Storage helper for settings and vocabulary
 */
const StorageHelper = {
    _settingsMutation: Promise.resolve(),
    _vocabularyMutation: Promise.resolve(),

    DEFAULT_SETTINGS: {
        enabled: true,
        targetLanguage: 'en',
        nativeLanguage: 'zh',
        proficiencyLevel: 'middle',
        // AI settings
        useAITranslation: false, // Safe first-run default: use YouTube translation until AI is configured
        aiProvider: 'local', // 'openai', 'custom', 'local'
        apiKey: '',
        apiEndpoint: 'https://api.openai.com/v1/chat/completions',
        apiModel: 'gpt-4o-mini',
        localEndpoint: 'http://localhost:11434/api/generate',
        localModel: 'qwen2.5:14b',
        // Display settings
        showPanel: false,
        subtitleDisplayMode: 'bilingual', // 'original', 'bilingual', 'translated'
        fontSize: 16,
        subtitlePosition: 'bottom', // 'bottom', 'top'
        subtitleBackgroundOpacity: 0.84,
        knownWordColor: '#4CAF50',
        unknownWordColor: '#FF9800',
        autoTranslate: true,
        showOriginalSubtitle: true,
        showTranslatedSubtitle: true,
        enableLogging: true,
        webPageTranslation: false
    },

    /**
     * Normalize old and partial settings without dropping unknown future fields.
     */
    normalizeSettings(settings = {}) {
        const merged = { ...this.DEFAULT_SETTINGS, ...(settings || {}) };

        // Older releases used an option that never existed in the UI.
        if (merged.proficiencyLevel === 'intermediate' || !['none', 'primary', 'middle', 'high', 'cet4', 'cet6'].includes(merged.proficiencyLevel)) {
            merged.proficiencyLevel = 'middle';
        }

        // Preserve the two legacy booleans while exposing one unambiguous mode.
        if (!['original', 'bilingual', 'translated'].includes(settings.subtitleDisplayMode)) {
            const showOriginal = settings.showOriginalSubtitle !== false;
            const showTranslated = settings.showTranslatedSubtitle !== false;
            merged.subtitleDisplayMode = showOriginal && showTranslated
                ? 'bilingual'
                : (showTranslated ? 'translated' : 'original');
        }
        merged.showOriginalSubtitle = merged.subtitleDisplayMode !== 'translated';
        merged.showTranslatedSubtitle = merged.subtitleDisplayMode !== 'original';

        merged.fontSize = Math.min(32, Math.max(12, Number(merged.fontSize) || 16));
        merged.subtitleBackgroundOpacity = Math.min(1, Math.max(0, Number(merged.subtitleBackgroundOpacity ?? 0.84)));
        merged.subtitlePosition = merged.subtitlePosition === 'top' ? 'top' : 'bottom';
        merged.knownWordColor = this.normalizeColor(merged.knownWordColor, this.DEFAULT_SETTINGS.knownWordColor);
        merged.unknownWordColor = this.normalizeColor(merged.unknownWordColor, this.DEFAULT_SETTINGS.unknownWordColor);
        return merged;
    },

    normalizeColor(value, fallback) {
        return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    },

    /**
     * Get all settings
     */
    async getSettings() {
        return new Promise((resolve) => {
            chrome.storage.sync.get('settings', (result) => {
                if (chrome.runtime?.lastError) {
                    console.warn('[YT Bilingual] Could not read settings:', chrome.runtime.lastError.message);
                    resolve(this.normalizeSettings({}));
                    return;
                }
                resolve(this.normalizeSettings(result?.settings || {}));
            });
        });
    },

    /**
     * Save settings
     */
    async saveSettings(settings) {
        if (typeof chrome.runtime?.sendMessage === 'function') {
            const response = await chrome.runtime.sendMessage({ action: 'updateSettings', patch: settings || {} });
            if (!response?.success) throw new Error(response?.error || 'Could not save settings.');
            return this.normalizeSettings(response.settings || {});
        }

        const operation = this._settingsMutation.then(() => new Promise((resolve, reject) => {
            chrome.storage.sync.get('settings', (result) => {
                const readError = chrome.runtime?.lastError;
                if (readError) {
                    reject(new Error(readError.message || 'Could not read settings.'));
                    return;
                }
                const merged = this.normalizeSettings({ ...(result.settings || {}), ...(settings || {}) });
                chrome.storage.sync.set({ settings: merged }, () => {
                    const writeError = chrome.runtime?.lastError;
                    if (writeError) reject(new Error(writeError.message || 'Could not save settings.'));
                    else resolve(merged);
                });
            });
        }));
        this._settingsMutation = operation.catch(() => undefined);
        return operation;
    },

    async updateSettings(patch) {
        return this.saveSettings(patch);
    },

    /**
     * Get vocabulary (known/unknown words)
     */
    async getVocabulary() {
        return new Promise((resolve) => {
            chrome.storage.local.get('vocabulary', (result) => {
                if (chrome.runtime?.lastError) {
                    console.warn('[YT Bilingual] Could not read vocabulary:', chrome.runtime.lastError.message);
                    resolve({});
                    return;
                }
                resolve(result?.vocabulary || {});
            });
        });
    },

    /**
     * Save a word to vocabulary
     * @param {string} word - The word
     * @param {string} status - 'known' or 'learning'
     * @param {string} definition - Word definition
     * @param {string} language - Language code
     */
    async saveWord(word, status, definition, language) {
        if (typeof chrome.runtime?.sendMessage === 'function') {
            const response = await chrome.runtime.sendMessage({
                action: 'saveVocabularyEntry',
                entry: { word, status, definition, language }
            });
            if (!response?.success) throw new Error(response?.error || 'Could not save vocabulary.');
            return response.entry;
        }

        const operation = this._vocabularyMutation.then(async () => {
            const vocab = await this.getVocabulary();
            const key = `${language}:${word.toLowerCase()}`;
            vocab[key] = {
                word: word.toLowerCase(),
                status,
                definition: definition || '',
                language,
                updatedAt: Date.now()
            };
            return new Promise((resolve, reject) => {
                chrome.storage.local.set({ vocabulary: vocab }, () => {
                    const error = chrome.runtime?.lastError;
                    if (error) reject(new Error(error.message || 'Could not save vocabulary.'));
                    else resolve(vocab[key]);
                });
            });
        });
        this._vocabularyMutation = operation.catch(() => undefined);
        return operation;
    },

    /**
     * Get word status
     */
    async getWordStatus(word, language) {
        const vocab = await this.getVocabulary();
        const key = `${language}:${word.toLowerCase()}`;
        return vocab[key] || null;
    },

    /**
     * Check if a word is known
     */
    async isWordKnown(word, language, level = 'none') {
        const entry = await this.getWordStatus(word, language);
        if (entry) return entry.status === 'known';

        if (language === 'en' && level !== 'none' && typeof window !== 'undefined' && window.WordLevels) {
            const w = word.toLowerCase();
            const WL = window.WordLevels;
            const inPrimary = WL.primary.includes(w);
            const inMiddle = inPrimary || WL.middle.includes(w);
            const inHigh = inMiddle || WL.high.includes(w);
            const inCet4 = inHigh || WL.cet4.includes(w);
            const inCet6 = inCet4 || WL.cet6.includes(w);

            if (level === 'primary' && inPrimary) return true;
            if (level === 'middle' && inMiddle) return true;
            if (level === 'high' && inHigh) return true;
            if (level === 'cet4' && inCet4) return true;
            if (level === 'cet6' && inCet6) return true;
        }

        return false;
    },

    /**
     * Get translation cache
     */
    async getCachedTranslation(text, targetLang, nativeLang) {
        return new Promise((resolve) => {
            const key = `tr_${targetLang}_${nativeLang}_${btoa(encodeURIComponent(text)).slice(0, 40)}`;
            chrome.storage.local.get(key, (result) => {
                resolve(result[key] || null);
            });
        });
    },

    /**
     * Cache a translation
     */
    async cacheTranslation(text, targetLang, nativeLang, translation) {
        return new Promise((resolve) => {
            const key = `tr_${targetLang}_${nativeLang}_${btoa(encodeURIComponent(text)).slice(0, 40)}`;
            const data = {};
            data[key] = { translation, timestamp: Date.now() };
            chrome.storage.local.set(data, resolve);
        });
    },

    /**
     * Get all vocabulary for a language with status filter
     */
    async getVocabularyByLanguage(language, status = null) {
        const vocab = await this.getVocabulary();
        const results = [];
        for (const [key, entry] of Object.entries(vocab)) {
            if (entry.language === language) {
                if (!status || entry.status === status) {
                    results.push(entry);
                }
            }
        }
        return results.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /**
     * Export vocabulary
     */
    async exportVocabulary() {
        const vocab = await this.getVocabulary();
        return JSON.stringify(vocab, null, 2);
    },

    /**
     * Import vocabulary
     */
    async importVocabulary(jsonStr) {
        try {
            const data = JSON.parse(jsonStr);
            const existing = await this.getVocabulary();
            const merged = { ...existing, ...data };
            return new Promise((resolve) => {
                chrome.storage.local.set({ vocabulary: merged }, () => resolve(true));
            });
        } catch (e) {
            return false;
        }
    }
};
