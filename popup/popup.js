/**
 * Popup Script
 */
document.addEventListener('DOMContentLoaded', async () => {
    const enableToggle = document.getElementById('enableToggle');
    const targetLang = document.getElementById('targetLanguage');
    const nativeLang = document.getElementById('nativeLanguage');
    const profLevel = document.getElementById('proficiencyLevel');
    const useAITranslation = document.getElementById('useAITranslation');
    const webPageTranslation = document.getElementById('webPageTranslation');
    const statusSection = document.getElementById('statusSection');
    const learningStat = document.getElementById('learningStat');
    const masteredStat = document.getElementById('masteredStat');

    // Load settings
    const settings = await StorageHelper.getSettings();
    enableToggle.checked = settings.enabled;
    targetLang.value = settings.targetLanguage;
    nativeLang.value = settings.nativeLanguage;
    profLevel.value = settings.proficiencyLevel;
    if (useAITranslation) useAITranslation.checked = settings.useAITranslation;
    if (webPageTranslation) webPageTranslation.checked = !!settings.webPageTranslation;

    updateStatus(settings.enabled);

    // Load stats
    const learningWords = await StorageHelper.getVocabularyByLanguage(settings.targetLanguage, 'learning');
    const masteredWords = await StorageHelper.getVocabularyByLanguage(settings.targetLanguage, 'known');
    learningStat.textContent = learningWords.length;
    masteredStat.textContent = masteredWords.length;

    // Event: Toggle enabled
    enableToggle.addEventListener('change', async () => {
        const newSettings = await StorageHelper.getSettings();
        newSettings.enabled = enableToggle.checked;
        await StorageHelper.saveSettings(newSettings);
        updateStatus(newSettings.enabled);

        // Notify content script
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { action: 'toggleExtension', enabled: newSettings.enabled });
        }
    });

    // Event: Use AI Translation
    if (useAITranslation) {
        useAITranslation.addEventListener('change', async () => {
            const newSettings = await StorageHelper.getSettings();
            newSettings.useAITranslation = useAITranslation.checked;
            await StorageHelper.saveSettings(newSettings);
        });
    }

    // Event: Webpage Translation toggle
    if (webPageTranslation) {
        webPageTranslation.addEventListener('change', async () => {
            const newSettings = await StorageHelper.getSettings();
            newSettings.webPageTranslation = webPageTranslation.checked;
            await StorageHelper.saveSettings(newSettings);
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'toggleWebTranslation',
                    enabled: webPageTranslation.checked
                }).catch(() => { /* tab may not have content script */ });
            }
        });
    }

    // Event: Change target language
    targetLang.addEventListener('change', async () => {
        const newSettings = await StorageHelper.getSettings();
        newSettings.targetLanguage = targetLang.value;
        await StorageHelper.saveSettings(newSettings);
    });

    // Event: Change native language
    nativeLang.addEventListener('change', async () => {
        const newSettings = await StorageHelper.getSettings();
        newSettings.nativeLanguage = nativeLang.value;
        await StorageHelper.saveSettings(newSettings);
    });

    // Event: Change proficiency level
    profLevel.addEventListener('change', async () => {
        const newSettings = await StorageHelper.getSettings();
        newSettings.proficiencyLevel = profLevel.value;
        await StorageHelper.saveSettings(newSettings);
    });

    // Event: Toggle panel
    document.getElementById('togglePanel').addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
        }
    });

    // Event: Open settings
    document.getElementById('openSettings').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    function updateStatus(enabled) {
        statusSection.classList.toggle('disabled', !enabled);
        statusSection.querySelector('.status-text').textContent = enabled ? 'Active' : 'Disabled';
    }
});
