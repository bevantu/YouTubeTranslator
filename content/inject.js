/**
 * inject.js — runs in the PAGE (MAIN) world at document_start.
 *
 * Intercepts ONLY timedtext (subtitle) requests from YouTube.
 * All other fetch/XHR calls are passed through completely unchanged
 * so we do not interfere with video streaming, analytics, etc.
 */
(function () {
    'use strict';

    const timedTextCache = new Map();
    const MAX_CACHE_ENTRIES = 16;

    function isTimedTextUrl(url) {
        return typeof url === 'string' && url.includes('timedtext');
    }

    function getVideoId(url) {
        try {
            const parsed = new URL(url, window.location.origin);
            const pageUrl = new URL(window.location.href);
            const pathMatch = pageUrl.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
            return parsed.searchParams.get('v') || pageUrl.searchParams.get('v') || pathMatch?.[1] || '';
        } catch {
            return '';
        }
    }

    function getCacheKey(url, videoId = getVideoId(url)) {
        try {
            const parsed = new URL(url, window.location.origin);
            return [
                videoId,
                parsed.searchParams.get('lang') || '',
                parsed.searchParams.get('tlang') || '',
                parsed.searchParams.get('kind') || '',
                parsed.searchParams.get('name') || '',
                parsed.searchParams.get('vssId') || ''
            ].join('|');
        } catch {
            return url;
        }
    }

    function dispatch(text, url, replay = false, capturedVideoId = '') {
        if (!text || text.length < 10) return;
        const detail = {
            text,
            url,
            videoId: capturedVideoId || getVideoId(url),
            capturedAt: Date.now(),
            replay
        };

        if (!replay) {
            const key = getCacheKey(url, detail.videoId);
            timedTextCache.delete(key);
            timedTextCache.set(key, detail);
            while (timedTextCache.size > MAX_CACHE_ENTRIES) {
                timedTextCache.delete(timedTextCache.keys().next().value);
            }
        }

        window.dispatchEvent(new CustomEvent('__yb_timedtext__', {
            detail
        }));
    }

    // The isolated content script may initialize after YouTube already fetched
    // captions. Re-deliver matching cached responses on request.
    window.addEventListener('__yb_timedtext_request__', (event) => {
        const requestedVideoId = event.detail?.videoId || '';
        for (const cached of timedTextCache.values()) {
            if (!requestedVideoId || cached.videoId === requestedVideoId) {
                dispatch(cached.text, cached.url, true, cached.videoId);
            }
        }
    });

    // ── Intercept fetch ───────────────────────────────────────────────────────
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input
            : (input instanceof Request ? input.url : '');

        // Pass non-timedtext requests through completely untouched
        if (!isTimedTextUrl(url)) {
            return origFetch.apply(this, arguments);
        }
        const capturedVideoId = getVideoId(url);

        // For timedtext: call original fetch, then read response text
        return origFetch.apply(this, arguments).then(response => {
            response.clone().text().then(text => dispatch(text, url, false, capturedVideoId)).catch(() => { });
            return response;
        });
    };

    // ── Intercept XMLHttpRequest ──────────────────────────────────────────────
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (isTimedTextUrl(url)) {
            this._ybUrl = url;
            this._ybVideoId = getVideoId(url);
            this.addEventListener('load', function () {
                dispatch(this.responseText, this._ybUrl, false, this._ybVideoId);
            });
        }
        return origOpen.apply(this, arguments);
    };
})();
