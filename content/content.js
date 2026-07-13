/**
 * YouTube content-script coordinator.
 * Keeps subtitle capture, navigation, display settings, panel state and popup
 * status synchronized without depending on YouTube's SPA timing.
 */
(function () {
    'use strict';

    const RESTART_SETTING_KEYS = [
        'targetLanguage', 'nativeLanguage', 'useAITranslation', 'autoTranslate',
        'aiProvider', 'apiKey', 'apiEndpoint', 'apiModel', 'localEndpoint', 'localModel'
    ];
    const pendingTimedText = new Map();

    let initialized = false;
    let managerReady = false;
    let processingTimedText = false;
    let currentSettings = null;
    let currentVideoId = '';
    let currentRouteKey = '';
    let routeGeneration = 0;
    let subtitleGeneration = null;
    let initTimer = null;
    let noCaptionTimer = null;
    let ccPollTimer = null;
    let ccObserver = null;
    let observedCcButton = null;
    let observedCcClickHandler = null;
    let subtitleDomObserver = null;
    let captionTracksAvailable = null;

    const runtimeStatus = {
        state: 'unsupported',
        message: 'Open a YouTube video to use bilingual subtitles.',
        detail: '',
        action: '',
        captionCount: 0,
        ccEnabled: null,
        captionTracksAvailable: null,
        updatedAt: Date.now()
    };

    function isVideoPage() {
        return window.location.pathname === '/watch'
            || window.location.pathname.startsWith('/shorts/')
            || window.location.pathname.startsWith('/embed/');
    }

    function getVideoId() {
        const url = new URL(window.location.href);
        if (url.pathname === '/watch') return url.searchParams.get('v') || '';
        const match = url.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
        return match ? match[1] : '';
    }

    function getRouteKey() {
        return isVideoPage() ? `${window.location.pathname}|${getVideoId()}` : window.location.pathname;
    }

    function getTimedTextKey(detail) {
        try {
            const url = new URL(detail.url, window.location.origin);
            return [
                detail.videoId || '',
                url.searchParams.get('lang') || '',
                url.searchParams.get('tlang') || '',
                url.searchParams.get('kind') || '',
                url.searchParams.get('name') || '',
                url.searchParams.get('vssId') || url.searchParams.get('vssid') || ''
            ].join('|');
        } catch {
            return detail.url || String(detail.capturedAt || Date.now());
        }
    }

    function normalizeStatusState(state) {
        const aliases = {
            loading: 'preparing',
            pending: 'preparing',
            normal: 'ready',
            success: 'ready',
            failed: 'error',
            failure: 'error',
            fallback: 'degraded',
            'translation-error': 'degraded',
            'translation-unavailable': 'degraded'
        };
        return aliases[state] || state || 'waiting';
    }

    function setStatus(state, message, extra = {}) {
        runtimeStatus.state = normalizeStatusState(state);
        runtimeStatus.message = message || runtimeStatus.message;
        runtimeStatus.detail = extra.detail || extra.error || '';
        runtimeStatus.action = extra.action || '';
        runtimeStatus.updatedAt = Date.now();
        if (Number.isFinite(extra.captionCount)) runtimeStatus.captionCount = extra.captionCount;
        if (typeof extra.ccEnabled === 'boolean' || extra.ccEnabled === null) {
            runtimeStatus.ccEnabled = extra.ccEnabled;
        }
        if (typeof extra.captionTracksAvailable === 'boolean' || extra.captionTracksAvailable === null) {
            runtimeStatus.captionTracksAvailable = extra.captionTracksAvailable;
        }
        SubtitlePanel.setStatus?.(runtimeStatus);
        renderPlayerStatus();
        document.dispatchEvent(new CustomEvent('yb-runtime-status', { detail: { ...runtimeStatus } }));
    }

    function renderPlayerStatus() {
        const player = document.querySelector('#movie_player');
        if (!player) return;

        let chip = player.querySelector('.yb-player-status');
        const shouldShow = ['error', 'degraded'].includes(runtimeStatus.state)
            || (runtimeStatus.action === 'enable-cc'
                && runtimeStatus.ccEnabled === false
                && runtimeStatus.captionTracksAvailable === true);

        if (!shouldShow) {
            chip?.remove();
            return;
        }

        if (!chip) {
            chip = document.createElement('div');
            chip.className = 'yb-player-status';
            chip.setAttribute('role', 'status');
            chip.innerHTML = '<span class="yb-player-status-text"></span><button type="button" class="yb-player-status-action"></button>';
            player.appendChild(chip);
        }
        chip.dataset.state = runtimeStatus.state;
        chip.querySelector('.yb-player-status-text').textContent = runtimeStatus.message;

        const button = chip.querySelector('.yb-player-status-action');
        if (runtimeStatus.action === 'enable-cc') {
            button.hidden = false;
            button.textContent = 'Turn on CC';
            button.onclick = () => ensureCaptionsEnabled();
        } else if (runtimeStatus.action === 'settings') {
            button.hidden = false;
            button.textContent = 'Settings';
            button.onclick = () => chrome.runtime.openOptionsPage();
        } else {
            button.hidden = true;
            button.onclick = null;
        }
    }

    function requestTimedTextReplay() {
        window.dispatchEvent(new CustomEvent('__yb_timedtext_request__', {
            detail: { videoId: currentVideoId }
        }));
    }

    function requestCaptionTrackStatus() {
        window.dispatchEvent(new CustomEvent('__yb_caption_tracks_request__', {
            detail: { videoId: currentVideoId }
        }));
    }

    function cancelSubtitleTranslations() {
        try {
            const request = chrome.runtime.sendMessage({
                action: 'cancelTranslationTasks',
                taskScope: 'youtube-subtitles'
            });
            request?.catch?.(() => undefined);
        } catch { /* the extension may already be unloading */ }
    }

    function waitForElement(selector, timeout = 10000, generation = routeGeneration) {
        return new Promise(resolve => {
            const existing = document.querySelector(selector);
            if (existing) return resolve(existing);

            const observer = new MutationObserver(() => {
                if (generation !== routeGeneration) {
                    observer.disconnect();
                    resolve(null);
                    return;
                }
                const element = document.querySelector(selector);
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    function applyCssSettings(settings) {
        const root = document.documentElement;
        root.style.setProperty('--yb-known-word-color', settings.knownWordColor);
        root.style.setProperty('--yb-unknown-word-color', settings.unknownWordColor);
        root.style.setProperty('--yb-subtitle-bg-opacity', String(settings.subtitleBackgroundOpacity));
        root.style.setProperty('--yb-subtitle-base-size', `${settings.fontSize}px`);
        root.dataset.ybDisplayMode = settings.subtitleDisplayMode;

        const container = document.getElementById('yt-bilingual-subtitles');
        if (container) {
            container.dataset.position = settings.subtitlePosition;
            container.dataset.displayMode = settings.subtitleDisplayMode;
        }
        const player = document.querySelector('#movie_player');
        if (player) player.dataset.ybDisplayMode = settings.subtitleDisplayMode;

        SubtitlePanel.updateDisplayMode?.(settings.subtitleDisplayMode);
        decorateSubtitleDom();
    }

    function decorateSubtitleDom() {
        const container = document.getElementById('yt-bilingual-subtitles');
        if (!container || !currentSettings) return;

        container.dataset.position = currentSettings.subtitlePosition;
        container.dataset.displayMode = currentSettings.subtitleDisplayMode;
        container.setAttribute('aria-label', 'Interactive bilingual subtitles');
        container.setAttribute('aria-live', 'off');

        container.querySelectorAll('.yb-subtitle-line').forEach(line => line.setAttribute('dir', 'auto'));
        container.querySelectorAll('.yb-word:not([data-yb-keyboard])').forEach(word => {
            word.dataset.ybKeyboard = 'true';
            word.setAttribute('role', 'button');
            word.setAttribute('tabindex', '0');
            word.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    word.click();
                }
            });
        });
    }

    function observeSubtitleDom() {
        subtitleDomObserver?.disconnect();
        const player = document.querySelector('#movie_player');
        if (!player) return;
        subtitleDomObserver = new MutationObserver(decorateSubtitleDom);
        subtitleDomObserver.observe(player, { childList: true, subtree: true });
        decorateSubtitleDom();
    }

    async function applySettings(settings, rerender = true) {
        currentSettings = StorageHelper.normalizeSettings(settings);
        applyCssSettings(currentSettings);

        if (managerReady && SubtitleManager.settings) {
            await SubtitleManager.updateSettings(currentSettings);
            if (rerender) {
                if (typeof SubtitleManager.forceRender === 'function') {
                    SubtitleManager.forceRender();
                } else {
                    SubtitleManager.lastRenderedText = '';
                    const video = document.querySelector('video');
                    if (video) SubtitleManager.onTimeUpdate(video.currentTime);
                }
                decorateSubtitleDom();
            }
        }

        if (currentSettings.showPanel && managerReady) SubtitlePanel.show?.(false);
        else if (!currentSettings.showPanel) SubtitlePanel.hide?.(false);
    }

    function enqueueTimedText(detail) {
        if (!detail?.text || detail.text.length < 10) return;
        if (detail.videoId && currentVideoId && detail.videoId !== currentVideoId) return;
        pendingTimedText.set(getTimedTextKey(detail), detail);
        processPendingTimedText();
    }

    async function processPendingTimedText() {
        if (processingTimedText || !managerReady || !isVideoPage()) return;
        processingTimedText = true;
        const generation = routeGeneration;

        try {
            while (pendingTimedText.size && managerReady && generation === routeGeneration) {
                const [key, detail] = pendingTimedText.entries().next().value;
                pendingTimedText.delete(key);
                if (detail.videoId && currentVideoId && detail.videoId !== currentVideoId) continue;

                setStatus('preparing', 'Preparing subtitles...', { captionCount: SubtitleManager.captions?.length || 0 });
                try {
                    await SubtitleManager.loadTimedText(detail.text, detail.url);
                    if (generation !== routeGeneration) break;
                    const captions = SubtitleManager.captions || [];
                    if (captions.length) {
                        runtimeStatus.captionCount = captions.length;
                        clearTimeout(noCaptionTimer);
                    }
                } catch (error) {
                    setStatus('error', 'Could not load subtitles.', { error: error.message, action: 'settings' });
                }
            }
        } finally {
            processingTimedText = false;
        }
    }

    function getCcEnabled(button = observedCcButton) {
        if (!button) return null;
        const pressed = button.getAttribute('aria-pressed');
        if (pressed === 'true') return true;
        if (pressed === 'false') return false;
        return null;
    }

    function canEnableCaptions(button = observedCcButton) {
        return Boolean(
            button
            && !button.disabled
            && button.getAttribute('aria-disabled') !== 'true'
            && !button.classList.contains('ytp-button-disabled')
        );
    }

    function canPromptToEnableCaptions(button = observedCcButton) {
        return (captionTracksAvailable === true || Boolean(SubtitleManager.captions?.length))
            && canEnableCaptions(button);
    }

    function syncCcState() {
        const enabled = getCcEnabled();
        runtimeStatus.ccEnabled = enabled;
        const player = document.querySelector('#movie_player');
        const shouldPromptToEnable = enabled === false && canPromptToEnableCaptions();
        player?.classList.toggle('yb-cc-disabled', shouldPromptToEnable);

        if (shouldPromptToEnable && currentSettings?.enabled) {
            SubtitleManager.setTranslationPaused?.(true);
            cancelSubtitleTranslations();
            SubtitleManager.hideNativeCaptions?.(false);
            setStatus('waiting', 'YouTube captions are turned off.', {
                ccEnabled: false,
                action: 'enable-cc',
                captionCount: SubtitleManager.captions?.length || 0,
                captionTracksAvailable
            });
        } else if (enabled === true) {
            SubtitleManager.setTranslationPaused?.(false);
            if (SubtitleManager.captions?.length) {
                SubtitleManager.hideNativeCaptions?.(true);
                setStatus('ready', 'Bilingual subtitles are ready.', {
                    ccEnabled: true,
                    captionCount: SubtitleManager.captions.length
                });
            } else {
                setStatus('waiting', "Waiting for this video's captions...", {
                    ccEnabled: true,
                    captionTracksAvailable
                });
                requestTimedTextReplay();
            }
        } else if (captionTracksAvailable === false && !SubtitleManager.captions?.length) {
            setStatus('no-captions', 'No usable captions were found for this video.', {
                ccEnabled: null,
                captionCount: 0,
                captionTracksAvailable: false
            });
        } else if (enabled === false) {
            setStatus('waiting', "Checking this video's captions...", {
                ccEnabled: null,
                captionTracksAvailable
            });
        }
    }

    function observeCcButton() {
        ccObserver?.disconnect();
        if (observedCcButton && observedCcClickHandler) {
            observedCcButton.removeEventListener('click', observedCcClickHandler);
        }
        observedCcButton = null;
        observedCcClickHandler = null;
        clearInterval(ccPollTimer);

        const connect = () => {
            const button = document.querySelector('.ytp-subtitles-button');
            if (!button || button === observedCcButton) return Boolean(button);
            observedCcButton = button;
            ccObserver = new MutationObserver(syncCcState);
            ccObserver.observe(button, { attributes: true, attributeFilter: ['aria-pressed', 'title'] });
            observedCcClickHandler = () => setTimeout(syncCcState, 0);
            button.addEventListener('click', observedCcClickHandler);
            syncCcState();
            return true;
        };

        if (!connect()) {
            ccPollTimer = setInterval(() => {
                if (connect()) clearInterval(ccPollTimer);
            }, 500);
        }
    }

    function ensureCaptionsEnabled() {
        const button = observedCcButton || document.querySelector('.ytp-subtitles-button');
        if (!button || !canPromptToEnableCaptions(button)) return false;
        if (getCcEnabled(button) === false) button.click();
        setStatus('preparing', 'Turning on captions...', { ccEnabled: true });
        setTimeout(requestTimedTextReplay, 250);
        return true;
    }

    function startNoCaptionTimer(generation) {
        clearTimeout(noCaptionTimer);
        noCaptionTimer = setTimeout(() => {
            if (generation !== routeGeneration || SubtitleManager.captions?.length) return;
            const ccEnabled = getCcEnabled();
            if (ccEnabled === false && canPromptToEnableCaptions()) {
                syncCcState();
            } else {
                setStatus('no-captions', 'No usable captions were found for this video.', {
                    ccEnabled,
                    captionCount: 0,
                    captionTracksAvailable
                });
            }
        }, 12000);
    }

    async function initialize(generation = routeGeneration) {
        if (initialized || !isVideoPage() || generation !== routeGeneration) return;
        initialized = true;
        currentVideoId = getVideoId();

        currentSettings = await StorageHelper.getSettings();
        if (generation !== routeGeneration) return;
        await applySettings(currentSettings, false);

        if (!currentSettings.enabled) {
            managerReady = false;
            setStatus('disabled', 'Bilingual subtitles are disabled.');
            return;
        }

        setStatus('waiting', 'Waiting for YouTube captions...', {
            captionCount: 0,
            captionTracksAvailable: null
        });
        requestTimedTextReplay();
        requestCaptionTrackStatus();

        const [video, player] = await Promise.all([
            waitForElement('video', 10000, generation),
            waitForElement('#movie_player', 10000, generation)
        ]);
        if (generation !== routeGeneration) return;
        if (!video || !player) {
            initialized = false;
            setStatus('error', 'The YouTube player did not become ready.', { action: 'settings' });
            return;
        }

        WordPopup.init();
        SubtitlePanel.init();
        await SubtitleManager.init(currentSettings);
        if (generation !== routeGeneration) {
            SubtitleManager.destroy();
            return;
        }

        managerReady = true;
        applyCssSettings(currentSettings);
        observeSubtitleDom();
        observeCcButton();
        startNoCaptionTimer(generation);
        requestTimedTextReplay();
        requestCaptionTrackStatus();
        processPendingTimedText();
    }

    function teardownVideo(reason = 'navigation') {
        clearTimeout(initTimer);
        clearTimeout(noCaptionTimer);
        clearInterval(ccPollTimer);
        ccObserver?.disconnect();
        subtitleDomObserver?.disconnect();
        if (observedCcButton && observedCcClickHandler) {
            observedCcButton.removeEventListener('click', observedCcClickHandler);
        }
        ccObserver = null;
        subtitleDomObserver = null;
        observedCcButton = null;
        observedCcClickHandler = null;
        SubtitleManager.setTranslationPaused?.(true);
        cancelSubtitleTranslations();

        if (managerReady || document.getElementById('yt-bilingual-subtitles')) {
            SubtitleManager.destroy();
        }
        managerReady = false;
        initialized = false;
        processingTimedText = false;
        subtitleGeneration = null;
        captionTracksAvailable = null;
        pendingTimedText.clear();
        SubtitlePanel.clear?.(reason === 'disabled' ? 'Disabled' : 'Waiting for captions...');
        SubtitlePanel.suspend?.();
        document.querySelector('.yb-player-status')?.remove();
        document.querySelector('#movie_player')?.classList.remove('yb-cc-disabled');
    }

    function handleRouteChange() {
        const nextKey = getRouteKey();
        if (nextKey === currentRouteKey && (initialized || initTimer)) return;
        currentRouteKey = nextKey;
        routeGeneration++;
        teardownVideo('navigation');
        currentVideoId = getVideoId();

        if (!isVideoPage()) {
            setStatus('unsupported', 'Open a YouTube video to use bilingual subtitles.', { captionCount: 0 });
            SubtitlePanel.hide?.(false);
            return;
        }

        const generation = routeGeneration;
        setStatus('waiting', 'Opening video...', {
            captionCount: 0,
            captionTracksAvailable: null
        });
        requestTimedTextReplay();
        initTimer = setTimeout(() => {
            initTimer = null;
            initialize(generation);
        }, 200);
    }

    function scheduleRouteCheck(delay = 50) {
        clearTimeout(initTimer);
        initTimer = setTimeout(() => {
            initTimer = null;
            handleRouteChange();
        }, delay);
    }

    function isEditableTarget(target) {
        return target instanceof HTMLElement
            && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    }

    window.addEventListener('__yb_timedtext__', event => enqueueTimedText(event.detail || {}));
    window.addEventListener('__yb_caption_tracks__', event => {
        const detail = event.detail || {};
        if (detail.videoId && currentVideoId && detail.videoId !== currentVideoId) return;
        if (typeof detail.available !== 'boolean') return;
        captionTracksAvailable = detail.available;
        syncCcState();
    });
    document.addEventListener('yt-navigate-start', () => scheduleRouteCheck(0));
    document.addEventListener('yt-navigate-finish', () => scheduleRouteCheck(50));
    window.addEventListener('popstate', () => scheduleRouteCheck(0));

    const routeObserver = new MutationObserver(() => {
        if (getRouteKey() !== currentRouteKey) scheduleRouteCheck(50);
    });
    routeObserver.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('yb-captions-ready', event => {
        const detail = event.detail || {};
        subtitleGeneration = detail.generation ?? subtitleGeneration;
        const captions = Array.isArray(detail) ? detail : (detail.captions || SubtitleManager.captions || []);
        clearTimeout(noCaptionTimer);
        runtimeStatus.captionCount = captions.length;
        setStatus('ready', captions.length ? 'Bilingual subtitles are ready.' : 'Waiting for captions...', {
            captionCount: captions.length,
            ccEnabled: getCcEnabled()
        });
        if (captions.length && currentSettings?.showPanel) SubtitlePanel.show?.(false);
    });

    document.addEventListener('yb-subtitle-status', event => {
        const detail = event.detail || {};
        if (subtitleGeneration != null && detail.generation != null && detail.generation !== subtitleGeneration) return;
        if (detail.generation != null) subtitleGeneration = detail.generation;
        const state = normalizeStatusState(detail.state);
        const action = state === 'error' ? 'settings' : '';
        setStatus(state, detail.message || (state === 'degraded' ? 'Using a fallback translation.' : 'Subtitle status changed.'), {
            error: detail.error || '',
            detail: detail.fallback ? `Fallback: ${detail.fallback}` : '',
            action,
            captionCount: SubtitleManager.captions?.length || runtimeStatus.captionCount,
            ccEnabled: getCcEnabled()
        });
    });

    document.addEventListener('keydown', event => {
        if (!currentSettings?.enabled || isEditableTarget(event.target)) return;
        if (event.altKey && event.shiftKey && event.code === 'KeyB') {
            event.preventDefault();
            SubtitlePanel.cycleDisplayMode?.();
        }
        if (event.altKey && event.shiftKey && event.code === 'KeyP') {
            event.preventDefault();
            SubtitlePanel.toggle?.();
        }
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'sync' || !changes.settings) return;
        const previous = currentSettings || StorageHelper.DEFAULT_SETTINGS;
        const next = StorageHelper.normalizeSettings(changes.settings.newValue || {});
        const needsRestart = RESTART_SETTING_KEYS.some(key => previous[key] !== next[key]);
        currentSettings = next;

        if (!next.enabled) {
            teardownVideo('disabled');
            setStatus('disabled', 'Bilingual subtitles are disabled.');
            return;
        }
        if (!previous.enabled && next.enabled) {
            currentRouteKey = '';
            handleRouteChange();
            return;
        }

        if (needsRestart && (managerReady || initialized)) {
            applyCssSettings(next);
            if (next.showPanel && managerReady) SubtitlePanel.show?.(false);
            else if (!next.showPanel) SubtitlePanel.hide?.(false);
            currentRouteKey = '';
            scheduleRouteCheck(50);
            return;
        }

        applySettings(next, true).catch(error => {
            setStatus('error', 'Could not apply subtitle settings.', {
                error: error?.message || String(error),
                action: 'settings'
            });
        });
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'getStatus') {
            sendResponse({
                ...runtimeStatus,
                initialized,
                managerReady,
                isVideoPage: isVideoPage(),
                videoId: currentVideoId,
                displayMode: currentSettings?.subtitleDisplayMode || 'bilingual'
            });
            return false;
        }
        if (message.action === 'togglePanel') {
            const available = Boolean(currentSettings?.enabled && managerReady && isVideoPage());
            if (available) SubtitlePanel.toggle?.();
            sendResponse({ success: available });
            return false;
        }
        if (message.action === 'ensureCaptionsEnabled') {
            sendResponse({ success: ensureCaptionsEnabled() });
            return false;
        }
        if (message.action === 'setDisplayMode') {
            StorageHelper.updateSettings({ subtitleDisplayMode: message.mode }).then(settings => {
                sendResponse({ success: true, settings });
            }).catch(error => sendResponse({ success: false, error: error.message }));
            return true;
        }
        if (message.action === 'toggleExtension') {
            if (message.enabled) {
                currentRouteKey = '';
                handleRouteChange();
            } else {
                teardownVideo('disabled');
                setStatus('disabled', 'Bilingual subtitles are disabled.');
            }
            sendResponse({ success: true });
            return false;
        }
        return false;
    });

    window.addEventListener('beforeunload', cancelSubtitleTranslations);

    handleRouteChange();
})();
