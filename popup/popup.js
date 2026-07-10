document.addEventListener('DOMContentLoaded', async () => {
    const elements = {
        enable: document.getElementById('enableToggle'),
        targetLanguage: document.getElementById('targetLanguage'),
        nativeLanguage: document.getElementById('nativeLanguage'),
        proficiency: document.getElementById('proficiencyLevel'),
        useAI: document.getElementById('useAITranslation'),
        webTranslation: document.getElementById('webPageTranslation'),
        mode: document.getElementById('displayMode'),
        status: document.getElementById('statusSection'),
        statusTitle: document.getElementById('statusTitle'),
        statusDetail: document.getElementById('statusDetail'),
        statusAction: document.getElementById('statusAction'),
        panel: document.getElementById('togglePanel'),
        settings: document.getElementById('openSettings'),
        learning: document.getElementById('learningStat'),
        mastered: document.getElementById('masteredStat'),
        version: document.getElementById('versionText')
    };

    let settings = await StorageHelper.getSettings();
    let activeTab = null;
    let latestStatus = null;
    let statusTimer = null;

    elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
    populate(settings);
    await Promise.all([refreshVocabularyStats(), refreshStatus()]);
    statusTimer = setInterval(refreshStatus, 1000);
    window.addEventListener('unload', () => clearInterval(statusTimer));

    function populate(value) {
        elements.enable.checked = value.enabled;
        elements.targetLanguage.value = value.targetLanguage;
        elements.nativeLanguage.value = value.nativeLanguage;
        elements.proficiency.value = value.proficiencyLevel;
        elements.useAI.checked = value.useAITranslation;
        elements.webTranslation.checked = Boolean(value.webPageTranslation);
        updateMode(value.subtitleDisplayMode);
    }

    function updateMode(mode) {
        elements.mode.querySelectorAll('button').forEach(button => {
            const active = button.dataset.mode === mode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    async function savePatch(patch) {
        try {
            settings = await StorageHelper.updateSettings(patch);
            return true;
        } catch (error) {
            populate(settings);
            renderStatus({
                ...(latestStatus || {}),
                state: 'error',
                message: 'Could not save settings.',
                detail: error.message || String(error),
                isVideoPage: Boolean(latestStatus?.isVideoPage)
            });
            return false;
        }
    }

    async function getActiveTab() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        activeTab = tabs[0] || null;
        return activeTab;
    }

    async function sendToActiveTab(message) {
        const tab = activeTab || await getActiveTab();
        if (!tab?.id) throw new Error('No active tab');
        return chrome.tabs.sendMessage(tab.id, message);
    }

    function renderStatus(status) {
        latestStatus = status;
        elements.status.dataset.state = status.state || 'waiting';
        elements.statusTitle.textContent = status.message || 'Checking video...';
        elements.statusDetail.textContent = status.detail
            || (status.captionCount ? `${status.captionCount} captions loaded` : '');
        elements.statusAction.hidden = true;
        elements.statusAction.onclick = null;
        elements.panel.disabled = !status.isVideoPage || status.state === 'disabled';

        if (status.action === 'enable-cc') {
            elements.statusAction.hidden = false;
            elements.statusAction.textContent = 'Turn on CC';
            elements.statusAction.onclick = async () => {
                await sendToActiveTab({ action: 'ensureCaptionsEnabled' }).catch(() => null);
                setTimeout(refreshStatus, 250);
            };
        } else if (status.action === 'settings' || status.state === 'error' || status.state === 'degraded') {
            elements.statusAction.hidden = false;
            elements.statusAction.textContent = 'Settings';
            elements.statusAction.onclick = () => chrome.runtime.openOptionsPage();
        }
    }

    async function refreshStatus() {
        const tab = await getActiveTab();
        const isYoutube = Boolean(tab?.url && /^https:\/\/(?:www\.)?youtube\.com\//.test(tab.url));
        if (!isYoutube) {
            renderStatus({
                state: settings.enabled ? 'unsupported' : 'disabled',
                message: settings.enabled ? 'Open a YouTube video.' : 'Bilingual subtitles are disabled.',
                detail: '',
                isVideoPage: false
            });
            return;
        }

        try {
            const status = await sendToActiveTab({ action: 'getStatus' });
            renderStatus(status || {
                state: 'waiting',
                message: 'Waiting for the video...',
                isVideoPage: false
            });
            if (status?.displayMode) updateMode(status.displayMode);
        } catch {
            renderStatus({
                state: 'waiting',
                message: 'Reload this YouTube tab to start subtitles.',
                detail: 'The page has not connected to the extension yet.',
                isVideoPage: false
            });
        }
    }

    async function refreshVocabularyStats() {
        const [learning, mastered] = await Promise.all([
            StorageHelper.getVocabularyByLanguage(settings.targetLanguage, 'learning'),
            StorageHelper.getVocabularyByLanguage(settings.targetLanguage, 'known')
        ]);
        elements.learning.textContent = learning.length;
        elements.mastered.textContent = mastered.length;
    }

    elements.enable.addEventListener('change', async () => {
        if (!await savePatch({ enabled: elements.enable.checked })) return;
        await sendToActiveTab({ action: 'toggleExtension', enabled: elements.enable.checked }).catch(() => null);
        refreshStatus();
    });

    elements.mode.addEventListener('click', async event => {
        const button = event.target.closest('button[data-mode]');
        if (!button) return;
        updateMode(button.dataset.mode);
        if (!await savePatch({ subtitleDisplayMode: button.dataset.mode })) return;
        await sendToActiveTab({ action: 'setDisplayMode', mode: button.dataset.mode }).catch(() => null);
    });

    elements.targetLanguage.addEventListener('change', async () => {
        if (!await savePatch({ targetLanguage: elements.targetLanguage.value })) return;
        await refreshVocabularyStats();
    });
    elements.nativeLanguage.addEventListener('change', () => savePatch({ nativeLanguage: elements.nativeLanguage.value }));
    elements.proficiency.addEventListener('change', () => savePatch({ proficiencyLevel: elements.proficiency.value }));
    elements.useAI.addEventListener('change', () => savePatch({ useAITranslation: elements.useAI.checked }));
    elements.webTranslation.addEventListener('change', async () => {
        if (!await savePatch({ webPageTranslation: elements.webTranslation.checked })) return;
        await sendToActiveTab({ action: 'toggleWebTranslation', enabled: elements.webTranslation.checked }).catch(() => null);
    });

    elements.panel.addEventListener('click', async () => {
        await sendToActiveTab({ action: 'togglePanel' }).catch(() => null);
        window.close();
    });
    elements.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
});
