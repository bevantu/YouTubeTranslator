/**
 * Content Script Entry Point
 */
(function () {
    'use strict';

    let initialized = false;

    function isVideoPage() {
        return window.location.pathname === '/watch';
    }

    async function initialize() {
        if (initialized || !isVideoPage()) return;
        initialized = true;

        console.log('[YT Bilingual] Initializing...');

        const settings = await StorageHelper.getSettings();
        if (!settings.enabled) {
            console.log('[YT Bilingual] Disabled');
            return;
        }

        await waitForElement('video');
        await waitForElement('#movie_player');

        WordPopup.init();
        SubtitlePanel.init();
        await SubtitleManager.init(settings);

        if (settings.showPanel) SubtitlePanel.show();

        console.log('[YT Bilingual] Ready. autoTranslate:', settings.autoTranslate,
            '| provider:', settings.aiProvider,
            '| target:', settings.targetLanguage, '→', settings.nativeLanguage);
    }

    function waitForElement(selector, timeout = 10000) {
        return new Promise(resolve => {
            if (document.querySelector(selector)) return resolve(document.querySelector(selector));
            const ob = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) { ob.disconnect(); resolve(el); }
            });
            ob.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { ob.disconnect(); resolve(null); }, timeout);
        });
    }

    // ── Listen for timedtext data from inject.js (MAIN world) ──────────────────
    // inject.js fires CustomEvent('__yb_timedtext__') on window when it captures
    // a YouTube subtitle API response.
    window.addEventListener('__yb_timedtext__', (e) => {
        const { text, url } = e.detail || {};
        if (text && initialized) {
            console.log('[YT Bilingual] Received timedtext data, length:', text.length);
            SubtitleManager.loadTimedText(text, url);
        }
    });

    // ── YouTube SPA navigation ─────────────────────────────────────────────────
    function handleNavigation() {
        let lastUrl = location.href;
        const ob = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                if (isVideoPage()) {
                    initialized = false;
                    SubtitlePanel.clear();
                    SubtitleManager.destroy();
                    setTimeout(() => initialize(), 1500);
                }
            }
        });
        ob.observe(document.querySelector('title') || document.body,
            { childList: true, subtree: true });

        document.addEventListener('yt-navigate-finish', () => {
            if (isVideoPage() && !initialized) {
                setTimeout(() => initialize(), 1000);
            }
        });
    }

    // ── Messages from popup / background ──────────────────────────────────────
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.settings) SubtitleManager.updateSettings(changes.settings.newValue);
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'toggleExtension') {
            if (msg.enabled) { initialized = false; initialize(); }
            else { SubtitleManager.destroy(); initialized = false; }
            sendResponse({ success: true });
        }
        if (msg.action === 'togglePanel') { SubtitlePanel.toggle(); sendResponse({ success: true }); }
        if (msg.action === 'getStatus') sendResponse({ initialized, isVideoPage: isVideoPage() });
        return true;
    });

    // ── Boot ───────────────────────────────────────────────────────────────────
    handleNavigation();
    if (isVideoPage()) setTimeout(() => initialize(), 1500);
})();
