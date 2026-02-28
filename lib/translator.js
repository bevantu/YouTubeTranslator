/**
 * AI Translation Service
 * Supports OpenAI-compatible APIs and local LLM (Ollama)
 */
const TranslatorService = {
    /**
     * Translate text using configured AI provider
     */
    async translate(text, targetLang, nativeLang, settings) {
        if (!text || !text.trim()) return '';

        // Check cache first
        const cached = await StorageHelper.getCachedTranslation(text, targetLang, nativeLang);
        if (cached) return cached.translation;

        let translation = '';
        try {
            if (settings.aiProvider === 'local') {
                translation = await this.translateWithLocal(text, targetLang, nativeLang, settings);
            } else {
                translation = await this.translateWithAPI(text, targetLang, nativeLang, settings);
            }

            // Cache the result
            if (translation) {
                await StorageHelper.cacheTranslation(text, targetLang, nativeLang, translation);
            }
        } catch (error) {
            console.error('[YT Bilingual] Translation error:', error);
            translation = `[Translation Error: ${error.message}]`;
        }

        return translation;
    },

    /**
     * Translate using OpenAI-compatible API
     */
    async translateWithAPI(text, targetLang, nativeLang, settings) {
        const targetName = LANGUAGES[targetLang]?.name || targetLang;
        const nativeName = LANGUAGES[nativeLang]?.name || nativeLang;

        const systemPrompt = `You are a professional translator. Translate the following ${targetName} text to ${nativeName}. Only output the translation, nothing else. Keep the tone and style natural.`;

        const response = await fetch(settings.apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                model: settings.apiModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                temperature: 0.3,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`API Error ${response.status}: ${err}`);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || '';
    },

    /**
     * Translate using local LLM (Ollama-compatible)
     */
    async translateWithLocal(text, targetLang, nativeLang, settings) {
        const targetName = LANGUAGES[targetLang]?.name || targetLang;
        const nativeName = LANGUAGES[nativeLang]?.name || nativeLang;

        const prompt = `Translate the following ${targetName} text to ${nativeName}. Only output the translation, nothing else:\n\n${text}`;

        // Try Ollama-style API first
        try {
            const response = await fetch(settings.localEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: settings.localModel,
                    prompt: prompt,
                    stream: false
                })
            });

            if (response.ok) {
                const data = await response.json();
                return data.response?.trim() || '';
            }
        } catch (e) {
            // Ollama-style failed, try OpenAI-compatible local API
        }

        // Fallback: OpenAI-compatible local endpoint (e.g., LM Studio, text-generation-webui)
        const openaiEndpoint = settings.localEndpoint.replace('/api/generate', '/v1/chat/completions');
        const response = await fetch(openaiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: settings.localModel,
                messages: [
                    { role: 'system', content: `You are a translator. Translate ${targetName} to ${nativeName}. Only output the translation.` },
                    { role: 'user', content: text }
                ],
                temperature: 0.3,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            throw new Error(`Local LLM Error: ${response.status}`);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || '';
    },

    /**
     * Get word definition using AI
     */
    async getWordDefinition(word, context, targetLang, nativeLang, settings) {
        const targetName = LANGUAGES[targetLang]?.name || targetLang;
        const nativeName = LANGUAGES[nativeLang]?.name || nativeLang;

        // Check cache
        const cacheKey = `def_${word}_${targetLang}_${nativeLang}`;
        const cached = await new Promise(r => chrome.storage.local.get(cacheKey, res => r(res[cacheKey])));
        if (cached) return cached;

        const systemPrompt = `You are a language learning assistant. Given a ${targetName} word and its context sentence, provide:
1. The word's pronunciation/transliteration (if applicable)
2. Part of speech
3. Translation to ${nativeName}
4. A brief explanation in ${nativeName}

Format your response EXACTLY as JSON:
{"pronunciation": "...", "pos": "...", "translation": "...", "explanation": "..."}`;

        const userPrompt = `Word: "${word}"\nContext: "${context}"`;

        try {
            let responseText = '';
            if (settings.aiProvider === 'local') {
                const prompt = `${systemPrompt}\n\n${userPrompt}`;
                const response = await fetch(settings.localEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: settings.localModel,
                        prompt: prompt,
                        stream: false
                    })
                });
                const data = await response.json();
                responseText = data.response || '';
            } else {
                const response = await fetch(settings.apiEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${settings.apiKey}`
                    },
                    body: JSON.stringify({
                        model: settings.apiModel,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt }
                        ],
                        temperature: 0.3,
                        max_tokens: 300
                    })
                });
                const data = await response.json();
                responseText = data.choices?.[0]?.message?.content || '';
            }

            // Parse JSON from response
            const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
                const def = JSON.parse(jsonMatch[0]);
                // Cache the definition
                const cacheData = {};
                cacheData[cacheKey] = def;
                chrome.storage.local.set(cacheData);
                return def;
            }
            return { translation: responseText.trim(), pronunciation: '', pos: '', explanation: '' };
        } catch (error) {
            console.error('[YT Bilingual] Definition error:', error);
            return { translation: '(Error getting definition)', pronunciation: '', pos: '', explanation: error.message };
        }
    },

    /**
     * Test API connection
     */
    async testConnection(settings) {
        try {
            const result = await this.translate('Hello', 'en', 'zh', settings);
            return { success: !!result, message: result || 'No response' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
};
