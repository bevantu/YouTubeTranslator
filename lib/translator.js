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
class TranslatorRequestError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'TranslatorRequestError';
        this.code = options.code || 'TRANSLATION_FAILED';
        this.retryable = Boolean(options.retryable);
        this.stale = Boolean(options.stale);
        this.details = options.details || null;
    }
}

function translationTaskFields(request = {}) {
    const task = request.task && typeof request.task === 'object' ? request.task : {};
    const taskId = request.taskId ?? request.id ?? task.id;
    const taskScope = request.taskScope ?? request.scope ?? task.scope;
    return {
        ...(taskId !== undefined ? { taskId } : {}),
        ...(taskScope !== undefined ? { taskScope } : {})
    };
}

async function sendTranslationRequest(message, fallbackMessage) {
    try {
        const response = await chrome.runtime.sendMessage(message);
        if (response?.success) return response.result;
        throw new TranslatorRequestError(response?.error || fallbackMessage, {
            code: response?.errorCode || 'TRANSLATION_FAILED',
            retryable: Boolean(response?.retryable),
            stale: Boolean(response?.stale),
            details: response?.details || null
        });
    } catch (error) {
        if (error instanceof TranslatorRequestError) throw error;
        throw new TranslatorRequestError(error?.message || fallbackMessage, {
            code: error?.code || 'MESSAGE_TRANSPORT_FAILED',
            retryable: error?.retryable !== false,
            stale: Boolean(error?.stale),
            details: error?.details || null
        });
    }
}

const TranslatorService = {

    /**
     * Translate text via Background Service Worker
     */
    async translate(text, targetLang, nativeLang, settings, context = [], mode = 'quality', request = {}) {
        if (!text || !text.trim()) return '';
        if (mode && typeof mode === 'object') {
            request = mode;
            mode = request.mode || 'quality';
        }
        const result = await sendTranslationRequest({
            action: 'translate',
            text,
            targetLang,
            nativeLang,
            settings,
            context,
            mode,
            ...translationTaskFields(request)
        }, 'Translation failed');
        if (!result) {
            throw new TranslatorRequestError('Translation returned no text.', {
                code: 'EMPTY_TRANSLATION_RESPONSE',
                retryable: true
            });
        }
        return result;
    },

    async translateFast(text, targetLang, nativeLang, settings, context = [], request = {}) {
        return this.translate(text, targetLang, nativeLang, settings, context, 'fast', request);
    },

    /**
     * Translate a block of numbered subtitle segments via Background SW.
    * @param {Array<{id: number, text: string, prevText?: string, nextText?: string, displayBreakReason?: string}>} segments - Numbered subtitle lines with optional neighboring source context
     * @param {string} targetLang - Source language
     * @param {string} nativeLang - Target (native) language
     * @param {object} settings - AI settings
     * @param {Array} context - Recent translation context
     * @returns {Object} - Map of { id: translation } for each segment
     */
    async translateBlock(segments, targetLang, nativeLang, settings, context = [], request = {}) {
        if (!segments || !segments.length) return {};
        const result = await sendTranslationRequest({
            action: 'translateBlock',
            segments,
            targetLang,
            nativeLang,
            settings,
            context,
            ...translationTaskFields(request)
        }, 'Block translation failed');
        const missingIds = segments
            .map(segment => String(segment.id))
            .filter(id => !String(result?.[id] || '').trim());
        if (!result || typeof result !== 'object' || missingIds.length > 0) {
            throw new TranslatorRequestError('Block translation returned an incomplete result.', {
                code: 'INCOMPLETE_BLOCK_RESPONSE',
                retryable: true,
                details: { missingIds }
            });
        }
        return result;
    },

    async translateStructuredBlock(segments, targetLang, nativeLang, settings, context = [], request = {}) {
        if (!segments || !segments.length) return {};
        const result = await sendTranslationRequest({
            action: 'translateStructuredBlock',
            segments,
            targetLang,
            nativeLang,
            settings,
            context,
            ...translationTaskFields(request)
        }, 'Structured block translation failed');
        const missingIds = segments
            .map(segment => String(segment.id))
            .filter(id => !String(result?.[id] || '').trim());
        if (!result || typeof result !== 'object' || missingIds.length > 0) {
            throw new TranslatorRequestError('Structured block translation returned an incomplete result.', {
                code: 'INCOMPLETE_STRUCTURED_BLOCK_RESPONSE',
                retryable: true,
                details: { missingIds }
            });
        }
        return result;
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
