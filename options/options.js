/**
 * Options Page Script
 */
document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const els = {
        targetLang: document.getElementById('targetLanguage'),
        nativeLang: document.getElementById('nativeLanguage'),
        profLevel: document.getElementById('proficiencyLevel'),
        apiKey: document.getElementById('apiKey'),
        apiEndpoint: document.getElementById('apiEndpoint'),
        apiModel: document.getElementById('apiModel'),
        localEndpoint: document.getElementById('localEndpoint'),
        localModel: document.getElementById('localModel'),
        fontSize: document.getElementById('fontSize'),
        fontSizeValue: document.getElementById('fontSizeValue'),
        knownColor: document.getElementById('knownWordColor'),
        unknownColor: document.getElementById('unknownWordColor'),
        showOriginal: document.getElementById('showOriginal'),
        showTranslation: document.getElementById('showTranslation'),
        autoTranslate: document.getElementById('autoTranslate'),
        showPanel: document.getElementById('showPanel'),
        totalWords: document.getElementById('totalWords'),
        learningCount: document.getElementById('learningCount'),
        masteredCount: document.getElementById('masteredCount'),
        testResult: document.getElementById('testResult'),
        saveMessage: document.getElementById('saveMessage')
    };

    // Load settings
    const settings = await StorageHelper.getSettings();
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
        const newSettings = collectSettings();
        await StorageHelper.saveSettings(newSettings);

        const msg = els.saveMessage;
        msg.style.display = 'block';
        setTimeout(() => { msg.style.display = 'none'; }, 3000);
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

    /**
     * Populate form with settings
     */
    function populateForm(s) {
        els.targetLang.value = s.targetLanguage;
        els.nativeLang.value = s.nativeLanguage;
        els.profLevel.value = s.proficiencyLevel;

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
        els.knownColor.value = s.knownWordColor;
        els.unknownColor.value = s.unknownWordColor;
        els.showOriginal.checked = s.showOriginalSubtitle;
        els.showTranslation.checked = s.showTranslatedSubtitle;
        els.autoTranslate.checked = s.autoTranslate;
        els.showPanel.checked = s.showPanel;
    }

    /**
     * Collect settings from form
     */
    function collectSettings() {
        return {
            enabled: true,
            targetLanguage: els.targetLang.value,
            nativeLanguage: els.nativeLang.value,
            proficiencyLevel: els.profLevel.value,
            aiProvider: document.querySelector('input[name="aiProvider"]:checked').value,
            apiKey: els.apiKey.value,
            apiEndpoint: els.apiEndpoint.value,
            apiModel: els.apiModel.value,
            localEndpoint: els.localEndpoint.value,
            localModel: els.localModel.value,
            showPanel: els.showPanel.checked,
            fontSize: parseInt(els.fontSize.value),
            knownWordColor: els.knownColor.value,
            unknownWordColor: els.unknownColor.value,
            autoTranslate: els.autoTranslate.checked,
            showOriginalSubtitle: els.showOriginal.checked,
            showTranslatedSubtitle: els.showTranslation.checked
        };
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
