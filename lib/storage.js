/**
 * Chrome Storage helper for settings and vocabulary
 */
const StorageHelper = {
    DEFAULT_SETTINGS: {
        enabled: true,
        targetLanguage: 'en',
        nativeLanguage: 'zh',
        proficiencyLevel: 'intermediate',
        // AI settings
        useAITranslation: true, // Toggle between AI translation and YouTube's native translation
        aiProvider: 'openai', // 'openai', 'custom', 'local'
        apiKey: '',
        apiEndpoint: 'https://api.openai.com/v1/chat/completions',
        apiModel: 'gpt-4o-mini',
        localEndpoint: 'http://localhost:11434/api/generate',
        localModel: 'llama3',
        // Display settings
        showPanel: true,
        fontSize: 16,
        subtitlePosition: 'bottom', // 'bottom', 'top'
        knownWordColor: '#4CAF50',
        unknownWordColor: '#FF9800',
        autoTranslate: true,
        showOriginalSubtitle: true,
        showTranslatedSubtitle: true,
        enableLogging: true,
        webPageTranslation: false
    },

    /**
     * Get all settings
     */
    async getSettings() {
        return new Promise((resolve) => {
            chrome.storage.sync.get('settings', (result) => {
                const settings = { ...this.DEFAULT_SETTINGS, ...(result.settings || {}) };
                resolve(settings);
            });
        });
    },

    /**
     * Save settings
     */
    async saveSettings(settings) {
        return new Promise((resolve) => {
            chrome.storage.sync.set({ settings }, resolve);
        });
    },

    /**
     * Get vocabulary (known/unknown words)
     */
    async getVocabulary() {
        return new Promise((resolve) => {
            chrome.storage.local.get('vocabulary', (result) => {
                resolve(result.vocabulary || {});
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
        const vocab = await this.getVocabulary();
        const key = `${language}:${word.toLowerCase()}`;
        vocab[key] = {
            word: word.toLowerCase(),
            status,
            definition: definition || '',
            language,
            updatedAt: Date.now()
        };
        return new Promise((resolve) => {
            chrome.storage.local.set({ vocabulary: vocab }, resolve);
        });
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
