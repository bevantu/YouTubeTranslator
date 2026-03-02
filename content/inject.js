/**
 * inject.js — runs in the PAGE (MAIN) world at document_start.
 *
 * Intercepts ONLY timedtext (subtitle) requests from YouTube.
 * All other fetch/XHR calls are passed through completely unchanged
 * so we do not interfere with video streaming, analytics, etc.
 */
(function () {
    'use strict';

    function isTimedTextUrl(url) {
        return typeof url === 'string' && url.includes('timedtext');
    }

    function dispatch(text, url) {
        if (!text || text.length < 10) return;
        window.dispatchEvent(new CustomEvent('__yb_timedtext__', {
            detail: { text, url }
        }));
    }

    // ── Intercept fetch ───────────────────────────────────────────────────────
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input
            : (input instanceof Request ? input.url : '');

        // Pass non-timedtext requests through completely untouched
        if (!isTimedTextUrl(url)) {
            return origFetch.apply(this, arguments);
        }

        // For timedtext: call original fetch, then read response text
        return origFetch.apply(this, arguments).then(response => {
            response.clone().text().then(text => dispatch(text, url)).catch(() => { });
            return response;
        });
    };

    // ── Intercept XMLHttpRequest ──────────────────────────────────────────────
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (isTimedTextUrl(url)) {
            this._ybUrl = url;
            this.addEventListener('load', function () {
                dispatch(this.responseText, this._ybUrl);
            });
        }
        return origOpen.apply(this, arguments);
    };
})();
