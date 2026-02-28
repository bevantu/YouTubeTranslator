/**
 * Content Script Entry Point
 * Initializes all components when on a YouTube video page
 */
(function () {
    'use strict';

    let initialized = false;

    /**
     * Check if we're on a YouTube video page
     */
    function isVideoPage() {
        return window.location.pathname === '/watch';
    }

    /**
     * Initialize the extension
     */
    async function initialize() {
        if (initialized || !isVideoPage()) return;
        initialized = true;

        console.log('[YT Bilingual] Initializing...');

        const settings = await StorageHelper.getSettings();
        if (!settings.enabled) {
            console.log('[YT Bilingual] Extension is disabled');
            return;
        }

        // Wait for video to be ready
        await waitForElement('video');
        await waitForElement('#movie_player');

        // Initialize components
        WordPopup.init();
        SubtitlePanel.init();
        await SubtitleManager.init(settings);

        // Show panel if enabled
        if (settings.showPanel) {
            SubtitlePanel.show();
        }

        console.log('[YT Bilingual] Initialized successfully!');
    }

    /**
     * Wait for an element to appear in the DOM
     */
    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);

            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    observer.disconnect();
                    resolve(el);
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    /**
     * Handle YouTube SPA navigation
     */
    function handleNavigation() {
        let lastUrl = location.href;

        // YouTube uses History API for SPA navigation
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                if (isVideoPage()) {
                    // Reset and reinitialize
                    initialized = false;
                    SubtitlePanel.clear();
                    SubtitleManager.destroy();
                    setTimeout(() => initialize(), 1500);
                }
            }
        });

        observer.observe(document.querySelector('title') || document.body, {
            childList: true,
            subtree: true
        });

        // Also listen for yt-navigate-finish event
        document.addEventListener('yt-navigate-finish', () => {
            if (isVideoPage() && !initialized) {
                setTimeout(() => initialize(), 1000);
            }
        });
    }

    /**
     * Listen for settings changes
     */
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (changes.settings) {
            const newSettings = changes.settings.newValue;
            SubtitleManager.updateSettings(newSettings);
        }
    });

    /**
     * Listen for messages from popup/background
     */
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'toggleExtension') {
            if (message.enabled) {
                initialized = false;
                initialize();
            } else {
                SubtitleManager.destroy();
                initialized = false;
            }
            sendResponse({ success: true });
        }
        if (message.action === 'togglePanel') {
            SubtitlePanel.toggle();
            sendResponse({ success: true });
        }
        if (message.action === 'getStatus') {
            sendResponse({ initialized, isVideoPage: isVideoPage() });
        }
        return true;
    });

    // Start
    handleNavigation();
    if (isVideoPage()) {
        // Delay to ensure YouTube is ready
        setTimeout(() => initialize(), 2000);
    }
})();
