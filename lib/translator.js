/**
 * Translator Service - Content Script Side
 *
 * All actual HTTP requests are handled by the Background Service Worker
 * (background/background.js) to avoid Mixed Content blocking.
 * HTTPS page (YouTube) cannot fetch a plain-HTTP Ollama server directly.
 * The Background SW runs in its own context and can reach any host listed
 * in host_permissions (http and https wildcards in manifest.json).
 *
 * This module is a thin messaging bridge: sends a message to background
 * and awaits the response. No direct fetch calls here.
 */
const TranslatorService = {

    /**
     * Translate text via Background Service Worker
     */
    async translate(text, targetLang, nativeLang, settings, context = [], mode = 'quality') {
        if (!text || !text.trim()) return '';
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'translate',
                text,
                targetLang,
                nativeLang,
                settings,
                context,
                mode
            });
            if (response?.success) return response.result || '';
            throw new Error(response?.error || 'Translation failed');
        } catch (err) {
            console.error('[YT Bilingual] translate error:', err);
            return '';
        }
    },

    /**
     * Translate a block of numbered subtitle segments via Background SW.
     * @param {Array<{id: number, text: string}>} segments - Numbered subtitle lines
     * @param {string} targetLang - Source language
     * @param {string} nativeLang - Target (native) language
     * @param {object} settings - AI settings
     * @param {Array} context - Recent translation context
     * @returns {Object} - Map of { id: translation } for each segment
     */
    async translateBlock(segments, targetLang, nativeLang, settings, context = []) {
        if (!segments || !segments.length) return {};
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'translateBlock',
                segments,
                targetLang,
                nativeLang,
                settings,
                context
            });
            if (response?.success) return response.result || {};
            throw new Error(response?.error || 'Block translation failed');
        } catch (err) {
            console.error('[YT Bilingual] translateBlock error:', err);
            return {};
        }
    },

    /**
     * Get word definition via Background Service Worker
     */
    async getWordDefinition(word, context, targetLang, nativeLang, settings) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getDefinition',
                word,
                context,
                targetLang,
                nativeLang,
                settings
            });
            if (response?.success) return response.result;
            throw new Error(response?.error || 'Definition failed');
        } catch (err) {
            console.error('[YT Bilingual] definition error:', err);
            return { pronunciation: '', pos: '', translation: '(Failed to load definition)', explanation: err.message };
        }
    },

    /**
     * Test connection via Background Service Worker
     */
    async testConnection(settings) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'testConnection',
                settings
            });
            if (response?.success) {
                return { success: true, message: response.result };
            }
            return { success: false, message: response?.error || 'Connection failed' };
        } catch (err) {
            return { success: false, message: err.message };
        }
    }
};
