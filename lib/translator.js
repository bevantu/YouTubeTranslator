/**
 * Translator Service — Content Script Side
 *
 * All actual HTTP requests are handled by the Background Service Worker
 * (background/background.js) to avoid Mixed Content blocking:
 *   HTTPS page (YouTube) → HTTP Ollama server would be blocked by Chrome.
 *   Background SW has its own security context and can reach HTTP hosts
 *   listed in host_permissions ("http://*/* ").
    *
 * This module is now just a messaging bridge: it sends a message to the
    * background and returns the response.
 */
const TranslatorService = {

    /**
     * Translate text via Background Service Worker
     */
    async translate(text, targetLang, nativeLang, settings) {
        if (!text || !text.trim()) return '';
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'translate',
                text,
                targetLang,
                nativeLang,
                settings
            });
            if (response?.success) return response.result || '';
            throw new Error(response?.error || 'Translation failed');
        } catch (err) {
            console.error('[YT Bilingual] translate error:', err);
            return '';
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
