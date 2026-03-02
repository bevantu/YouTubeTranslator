/**
 * inject.js — runs in the PAGE (MAIN) world.
 *
 * Content scripts live in an "isolated world" and cannot intercept the
 * page's own fetch/XHR calls. To capture YouTube's timedtext (subtitle)
 * requests we must be injected directly into the page context.
 *
 * Once we capture a timedtext response we dispatch a CustomEvent on
 * window so the isolated-world content script can pick it up.
 */
(function () {
    'use strict';

    function maybeCapture(url, getText) {
        if (!url) return;
        // Match YouTube's subtitle API
        if (!url.includes('timedtext') && !url.includes('youtube_timedtext')) return;

        getText().then(text => {
            if (!text) return;
            window.dispatchEvent(new CustomEvent('__yb_timedtext__', {
                detail: { text, url }
            }));
        }).catch(() => { });
    }

    // ── Intercept fetch ─────────────────────────────────────────────────────────
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input
            : (input instanceof Request ? input.url : '');
        const promise = origFetch.apply(this, arguments);
        maybeCapture(url, () => promise.then(r => r.clone().text()));
        return promise;
    };

    // ── Intercept XMLHttpRequest ────────────────────────────────────────────────
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this._ybUrl = typeof url === 'string' ? url : '';
        return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
        if (this._ybUrl && this._ybUrl.includes('timedtext')) {
            this.addEventListener('load', () => {
                maybeCapture(this._ybUrl, () => Promise.resolve(this.responseText));
            });
        }
        return origSend.apply(this, arguments);
    };
})();
