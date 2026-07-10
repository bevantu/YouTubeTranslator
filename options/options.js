/**
 * Options Page Script
 */
document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const els = {
        targetLang: document.getElementById('targetLanguage'),
        nativeLang: document.getElementById('nativeLanguage'),
        profLevel: document.getElementById('proficiencyLevel'),
        useAITranslation: document.getElementById('useAITranslation'),
        apiKey: document.getElementById('apiKey'),
        apiEndpoint: document.getElementById('apiEndpoint'),
        apiModel: document.getElementById('apiModel'),
        localEndpoint: document.getElementById('localEndpoint'),
        localModel: document.getElementById('localModel'),
        fontSize: document.getElementById('fontSize'),
        fontSizeValue: document.getElementById('fontSizeValue'),
        subtitlePosition: document.getElementById('subtitlePosition'),
        backgroundOpacity: document.getElementById('subtitleBackgroundOpacity'),
        backgroundOpacityValue: document.getElementById('backgroundOpacityValue'),
        preview: document.getElementById('subtitlePreview'),
        knownColor: document.getElementById('knownWordColor'),
        unknownColor: document.getElementById('unknownWordColor'),
        autoTranslate: document.getElementById('autoTranslate'),
        enableLogging: document.getElementById('enableLogging'),
        showPanel: document.getElementById('showPanel'),
        totalWords: document.getElementById('totalWords'),
        learningCount: document.getElementById('learningCount'),
        masteredCount: document.getElementById('masteredCount'),
        testResult: document.getElementById('testResult'),
        saveMessage: document.getElementById('saveMessage')
    };

    // Load settings
    let settings = await StorageHelper.getSettings();
    populateForm(settings);

    // Load vocabulary stats
    await loadVocabStats(settings);

    // Provider radio buttons
    document.querySelectorAll('input[name="aiProvider"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const provider = radio.value;
            document.getElementById('cloudSettings').style.display =
                (provider === 'openai' || provider === 'custom') ? 'block' : 'none';
            document.getElementById('localSettings').style.display =
                provider === 'local' ? 'block' : 'none';
        });
    });

    // Font size slider
    els.fontSize.addEventListener('input', () => {
        els.fontSizeValue.textContent = els.fontSize.value;
        updatePreview();
    });
    els.backgroundOpacity.addEventListener('input', () => {
        els.backgroundOpacityValue.textContent = els.backgroundOpacity.value;
        updatePreview();
    });
    [
        els.fontSize, els.backgroundOpacity, els.subtitlePosition,
        els.knownColor, els.unknownColor,
        ...document.querySelectorAll('input[name="subtitleDisplayMode"]')
    ].forEach(control => {
        control.addEventListener('input', scheduleDisplaySave);
        control.addEventListener('change', scheduleDisplaySave);
    });

    // Toggle API key visibility
    document.getElementById('toggleApiKey').addEventListener('click', () => {
        els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
    });

    // Test connection — routed via Background Service Worker to avoid mixed-content blocks
    document.getElementById('testConnection').addEventListener('click', async () => {
        const testResult = els.testResult;
        testResult.style.display = 'block';
        testResult.className = 'test-result';
        testResult.textContent = '⏳ Testing connection...';

        const testSettings = collectSettings();
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'testConnection',
                settings: testSettings
            });
            if (response?.success) {
                testResult.className = 'test-result success';
                testResult.textContent = `✓ Connection successful! Translation: "${response.result}"`;
            } else {
                testResult.className = 'test-result error';
                testResult.textContent = `✗ Connection failed: ${response?.error || 'Unknown error'}`;
            }
        } catch (err) {
            testResult.className = 'test-result error';
            testResult.textContent = `✗ Connection failed: ${err.message}`;
        }
    });

    // Save settings
    document.getElementById('saveSettings').addEventListener('click', async () => {
        try {
            settings = await StorageHelper.saveSettings(collectSettings());
            showSaveMessage('? Settings saved successfully.');
        } catch (error) {
            populateForm(settings);
            showSaveMessage(`Could not save settings: ${error.message}`, true);
        }
    });

    // Export vocabulary
    document.getElementById('exportVocab').addEventListener('click', async () => {
        const data = await StorageHelper.exportVocabulary();
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vocabulary_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // Import vocabulary
    document.getElementById('importVocab').addEventListener('click', () => {
        document.getElementById('importFile').click();
    });

    document.getElementById('importFile').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            const success = await StorageHelper.importVocabulary(event.target.result);
            if (success) {
                await loadVocabStats(settings);
                alert('Vocabulary imported successfully!');
            } else {
                alert('Failed to import vocabulary. Please check the file format.');
            }
        };
        reader.readAsText(file);
    });

    // Clear vocabulary
    document.getElementById('clearVocab').addEventListener('click', async () => {
        if (confirm('Are you sure you want to clear all vocabulary data? This action cannot be undone.')) {
            await new Promise(r => chrome.storage.local.set({ vocabulary: {} }, r));
            await loadVocabStats(settings);
        }
    });

    // Clear translation cache
    document.getElementById('clearCache').addEventListener('click', async () => {
        if (confirm('Clear all cached translations and dictionary lookups?')) {
            try {
                const response = await chrome.runtime.sendMessage({ action: 'clearCache' });
                if (response?.success) {
                    alert(`✓ Cache cleared! Removed ${response.count} cached entries.`);
                }
            } catch (err) {
                alert('Failed to clear cache: ' + err.message);
            }
        }
    });

    /**
     * Populate form with settings
     */
    function populateForm(s) {
        els.targetLang.value = s.targetLanguage;
        els.nativeLang.value = s.nativeLanguage;
        els.profLevel.value = s.proficiencyLevel;
        if (els.useAITranslation) els.useAITranslation.checked = s.useAITranslation;

        // AI settings
        document.querySelector(`input[name="aiProvider"][value="${s.aiProvider}"]`).checked = true;
        els.apiKey.value = s.apiKey;
        els.apiEndpoint.value = s.apiEndpoint;
        els.apiModel.value = s.apiModel;
        els.localEndpoint.value = s.localEndpoint;
        els.localModel.value = s.localModel;

        // Show correct provider settings
        document.getElementById('cloudSettings').style.display =
            (s.aiProvider === 'openai' || s.aiProvider === 'custom') ? 'block' : 'none';
        document.getElementById('localSettings').style.display =
            s.aiProvider === 'local' ? 'block' : 'none';

        // Display settings
        els.fontSize.value = s.fontSize;
        els.fontSizeValue.textContent = s.fontSize;
        els.subtitlePosition.value = s.subtitlePosition;
        els.backgroundOpacity.value = Math.round(s.subtitleBackgroundOpacity * 100);
        els.backgroundOpacityValue.textContent = Math.round(s.subtitleBackgroundOpacity * 100);
        els.knownColor.value = s.knownWordColor;
        els.unknownColor.value = s.unknownWordColor;
        const mode = document.querySelector(`input[name="subtitleDisplayMode"][value="${s.subtitleDisplayMode}"]`);
        if (mode) mode.checked = true;
        els.autoTranslate.checked = s.autoTranslate;
        els.enableLogging.checked = s.enableLogging;
        els.showPanel.checked = s.showPanel;
        updatePreview();
    }

    /**
     * Collect settings from form
     */
    function collectSettings() {
        const displayMode = document.querySelector('input[name="subtitleDisplayMode"]:checked')?.value || 'bilingual';
        return {
            ...settings,
            targetLanguage: els.targetLang.value,
            nativeLanguage: els.nativeLang.value,
            proficiencyLevel: els.profLevel.value,
            useAITranslation: els.useAITranslation ? els.useAITranslation.checked : true,
            aiProvider: document.querySelector('input[name="aiProvider"]:checked').value,
            apiKey: els.apiKey.value,
            apiEndpoint: els.apiEndpoint.value,
            apiModel: els.apiModel.value,
            localEndpoint: els.localEndpoint.value,
            localModel: els.localModel.value,
            showPanel: els.showPanel.checked,
            subtitleDisplayMode: displayMode,
            fontSize: parseInt(els.fontSize.value),
            subtitlePosition: els.subtitlePosition.value,
            subtitleBackgroundOpacity: parseInt(els.backgroundOpacity.value) / 100,
            knownWordColor: els.knownColor.value,
            unknownWordColor: els.unknownColor.value,
            autoTranslate: els.autoTranslate.checked,
            enableLogging: els.enableLogging.checked,
            showOriginalSubtitle: displayMode !== 'translated',
            showTranslatedSubtitle: displayMode !== 'original'
        };
    }

    function collectDisplaySettings() {
        const displayMode = document.querySelector('input[name="subtitleDisplayMode"]:checked')?.value || 'bilingual';
        return {
            subtitleDisplayMode: displayMode,
            showOriginalSubtitle: displayMode !== 'translated',
            showTranslatedSubtitle: displayMode !== 'original',
            fontSize: parseInt(els.fontSize.value),
            subtitlePosition: els.subtitlePosition.value,
            subtitleBackgroundOpacity: parseInt(els.backgroundOpacity.value) / 100,
            knownWordColor: els.knownColor.value,
            unknownWordColor: els.unknownColor.value
        };
    }

    let displaySaveTimer = null;
    let saveMessageTimer = null;
    function showSaveMessage(message, isError = false, timeout = 3000) {
        clearTimeout(saveMessageTimer);
        els.saveMessage.textContent = message;
        els.saveMessage.classList.toggle('error', isError);
        els.saveMessage.style.display = 'block';
        saveMessageTimer = setTimeout(() => {
            els.saveMessage.style.display = 'none';
            els.saveMessage.classList.remove('error');
        }, timeout);
    }

    function scheduleDisplaySave() {
        updatePreview();
        clearTimeout(displaySaveTimer);
        displaySaveTimer = setTimeout(async () => {
            try {
                settings = await StorageHelper.updateSettings(collectDisplaySettings());
                showSaveMessage('Display changes applied live.', false, 1400);
            } catch (error) {
                populateForm(settings);
                showSaveMessage(`Could not apply display changes: ${error.message}`, true);
            }
        }, 150);
    }

    function updatePreview() {
        if (!els.preview) return;
        const mode = document.querySelector('input[name="subtitleDisplayMode"]:checked')?.value || 'bilingual';
        els.preview.dataset.mode = mode;
        els.preview.dataset.position = els.subtitlePosition.value;
        els.preview.style.setProperty('--preview-font-size', `${els.fontSize.value}px`);
        els.preview.style.setProperty('--preview-bg-opacity', String(parseInt(els.backgroundOpacity.value) / 100));
        els.preview.style.setProperty('--preview-known-color', els.knownColor.value);
        els.preview.style.setProperty('--preview-unknown-color', els.unknownColor.value);
    }

    /**
     * Load vocabulary statistics
     */
    async function loadVocabStats(s) {
        const learning = await StorageHelper.getVocabularyByLanguage(s.targetLanguage, 'learning');
        const mastered = await StorageHelper.getVocabularyByLanguage(s.targetLanguage, 'known');
        els.learningCount.textContent = learning.length;
        els.masteredCount.textContent = mastered.length;
        els.totalWords.textContent = learning.length + mastered.length;
    }
});
