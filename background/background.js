/**
 * Background Service Worker
 * Handles extension lifecycle and message routing
 */

// Extension install/update handler
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        // Set default settings on first install
        chrome.storage.sync.get('settings', (result) => {
            if (!result.settings) {
                chrome.storage.sync.set({
                    settings: {
                        enabled: true,
                        targetLanguage: 'en',
                        nativeLanguage: 'zh',
                        proficiencyLevel: 'intermediate',
                        aiProvider: 'openai',
                        apiKey: '',
                        apiEndpoint: 'https://api.openai.com/v1/chat/completions',
                        apiModel: 'gpt-4o-mini',
                        localEndpoint: 'http://localhost:11434/api/generate',
                        localModel: 'llama3',
                        showPanel: true,
                        fontSize: 16,
                        subtitlePosition: 'bottom',
                        knownWordColor: '#4CAF50',
                        unknownWordColor: '#FF9800',
                        autoTranslate: true,
                        showOriginalSubtitle: true,
                        showTranslatedSubtitle: true
                    }
                });
            }
        });

        // Open options page on first install
        chrome.runtime.openOptionsPage();
    }
});

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'openOptions') {
        chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
    }

    if (message.action === 'getSettings') {
        chrome.storage.sync.get('settings', (result) => {
            sendResponse(result.settings || {});
        });
        return true; // async response
    }

    return true;
});

// Badge management
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.settings) {
        const enabled = changes.settings.newValue?.enabled;
        chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    }
});
