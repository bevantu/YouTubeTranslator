/**
 * Web Page Translator
 *
 * Translates English text on any webpage into the user's native language.
 * Features:
 *  - Paragraph-by-paragraph translation with LLM context window
 *  - Word-level coloring by English proficiency level (reuses WordLevels)
 *  - Hover: single-word highlight (semi-transparent background)
 *  - Ctrl+Hover: whole-sentence highlight + corresponding translation sentence
 *  - Click: WordPopup with dictionary + AI definition (reuses WordPopup)
 *  - Stop: fully restores the original page DOM
 *  - MutationObserver: handles SPA dynamic content
 */
(function () {
    'use strict';

    // ── State ───────────────────────────────────────────────────────────────────

    let isActive = false;
    let settings = null;
    let translationContext = [];
    let paragraphQueue = [];
    let isTranslating = false;
    let translationIdCounter = 0;
    let indicator = null;
    let processedCount = 0;
    let totalCount = 0;
    let ctrlHeld = false;
    let mutationObserver = null;
    let dynamicDebounce = null;

    // ── Boot ────────────────────────────────────────────────────────────────────

    async function bootstrap() {
        settings = await StorageHelper.getSettings();
        if (settings.webPageTranslation) {
            start();
        }
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === 'toggleWebTranslation') {
            if (msg.enabled) {
                start();
            } else {
                stop();
            }
            sendResponse({ success: true });
        }
        return true;
    });

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.settings) {
            settings = { ...settings, ...changes.settings.newValue };
        }
    });

    // Track Ctrl key
    document.addEventListener('keydown', (e) => { if (e.key === 'Control') ctrlHeld = true; });
    document.addEventListener('keyup', (e) => { if (e.key === 'Control') ctrlHeld = false; });

    // ── Start / Stop ────────────────────────────────────────────────────────────

    function start() {
        if (isActive) return;
        isActive = true;
        translationContext = [];
        translationIdCounter = 0;
        processedCount = 0;
        paragraphQueue = [];

        WordPopup.init();
        showIndicator('扫描页面...');

        // Slight delay so the DOM has fully rendered (esp. for SPAs)
        setTimeout(() => {
            collectAndTranslate();
            startMutationObserver();
        }, 800);
    }

    function stop() {
        isActive = false;
        isTranslating = false;
        paragraphQueue = [];
        stopMutationObserver();
        removeIndicator();
        restorePage();
    }

    // ── MutationObserver for SPA dynamic content ─────────────────────────────────

    function startMutationObserver() {
        if (mutationObserver) return;
        mutationObserver = new MutationObserver(() => {
            if (!isActive) return;
            clearTimeout(dynamicDebounce);
            dynamicDebounce = setTimeout(() => {
                if (isActive) collectAndTranslate();
            }, 1500);
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    function stopMutationObserver() {
        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
        }
        clearTimeout(dynamicDebounce);
    }

    // ── DOM Restoration ─────────────────────────────────────────────────────────

    function restorePage() {
        document.querySelectorAll('.yb-web-translation').forEach(el => el.remove());

        document.querySelectorAll('.yb-web-original').forEach(el => {
            const original = el.getAttribute('data-yb-original-html');
            if (original !== null) {
                el.innerHTML = original;
            }
            el.classList.remove('yb-web-original');
            el.removeAttribute('data-yb-original-html');
            el.removeAttribute('data-yb-translated');
            el.removeAttribute('data-yb-para-id');
        });
    }

    // ── Paragraph Collection ─────────────────────────────────────────────────────

    // Leaf-level inline content elements
    const LEAF_SELECTORS = 'p, li, td, th, blockquote, figcaption, dt, dd, caption';
    // Heading elements
    const HEADING_SELECTORS = 'h1, h2, h3, h4, h5, h6';

    function collectAndTranslate() {
        const toTranslate = [];
        const seen = new WeakSet();

        // 1. Collect headings and leaf content elements
        const leafEls = document.querySelectorAll(`${LEAF_SELECTORS}, ${HEADING_SELECTORS}`);
        leafEls.forEach(el => {
            if (seen.has(el) || shouldSkip(el)) return;
            seen.add(el);
            toTranslate.push(el);
        });

        // 2. Collect standalone text in content containers that weren't covered above.
        //    Walk main content areas and find direct-child divs/spans with substantial text
        //    that have no translatable descendants (avoids double-counting).
        const contentRoots = [
            ...document.querySelectorAll('main, article, [role="main"], .content, .post-content, .entry-content, .markdown-body, .prose, .article-body, .doc-content')
        ];
        contentRoots.forEach(root => {
            // Find all divs/sections that contain text but have no p/li children
            const candidates = root.querySelectorAll('div, section, span');
            candidates.forEach(el => {
                if (seen.has(el) || shouldSkip(el)) return;
                // Skip if it has descendant leaf elements (text will be covered by them)
                if (el.querySelector('p, li, h1, h2, h3, h4, h5, h6, blockquote')) return;
                // Must have substantial direct text
                const directText = getDirectText(el);
                if (directText.length < 20) return;
                seen.add(el);
                toTranslate.push(el);
            });
        });

        if (toTranslate.length === 0) {
            if (processedCount === 0) removeIndicator();
            return;
        }

        totalCount += toTranslate.length;
        showIndicator(`翻译中 ${processedCount} / ${totalCount}`);

        const newItems = toTranslate.map(el => {
            const id = ++translationIdCounter;
            el.setAttribute('data-yb-translated', 'pending');
            el.setAttribute('data-yb-para-id', id);
            el.setAttribute('data-yb-original-html', el.innerHTML);
            return { id, el, text: el.innerText.trim() };
        });

        paragraphQueue.push(...newItems);
        processQueue();
    }

    /**
     * Get the text content that is *directly* in this element,
     * not inside child elements (to avoid counting nested element text twice).
     */
    function getDirectText(el) {
        let text = '';
        for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            }
        }
        return text.trim();
    }

    function shouldSkip(el) {
        // Already processed or queued
        if (el.hasAttribute('data-yb-translated')) return true;
        // Inside our own injected translation blocks
        if (el.closest('.yb-web-translation')) return true;
        // Inside non-content areas (chrome: nav, header, footer, sidebar)
        if (el.closest('script, style, noscript')) return true;
        if (el.closest('[contenteditable="true"]')) return true;
        // Skip code blocks - no translation needed
        if (el.closest('code, pre, kbd, samp')) return true;
        // Skip navigation, banners — but NOT aside unless it's a sidebar nav
        if (el.closest('nav, [role="navigation"], [role="banner"]')) return true;
        // Skip hidden elements — use computed style instead of offsetParent
        // offsetParent is unreliable: returns null for overflow:hidden ancestors, position:fixed, etc.
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
        // Skip form elements / buttons
        if (el.closest('form, button, input, select, textarea')) return true;

        const text = el.innerText.trim();
        // Too short to bother translating
        if (text.length < 20) return true;
        // Already mostly CJK (user's native language or already translated)
        const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
        if (cjkChars / text.length > 0.3) return true;
        // Must contain some Latin letters (avoid pure symbol/number content)
        // Lowered threshold to 0.20 so that technical docs with code-heavy text still get translated
        const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
        if (latinChars / text.length < 0.20) return true;

        return false;
    }

    // ── Translation Queue ────────────────────────────────────────────────────────

    const BATCH_SIZE = 8;

    async function processQueue() {
        if (!isActive || isTranslating || paragraphQueue.length === 0) return;
        isTranslating = true;

        while (isActive && paragraphQueue.length > 0) {
            const batch = paragraphQueue.splice(0, BATCH_SIZE);
            await translateBatch(batch);
            processedCount += batch.length;
            updateIndicator(`翻译中 ${processedCount} / ${totalCount}`);
        }

        isTranslating = false;
        if (isActive && paragraphQueue.length === 0) {
            removeIndicator();
        }
    }

    async function translateBatch(batch) {
        if (!settings) settings = await StorageHelper.getSettings();

        // Filter out elements disconnected from DOM since queued
        const validBatch = batch.filter(item => item.el.isConnected);

        if (validBatch.length === 0) return;

        const segments = validBatch.map(item => ({ id: item.id, text: item.text }));

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'translateWebParagraphs',
                paragraphs: segments,
                targetLang: settings.targetLanguage || 'en',
                nativeLang: settings.nativeLanguage || 'zh',
                settings,
                context: translationContext.slice(-4)
            });

            if (response?.success && response.result) {
                for (const item of validBatch) {
                    const translation = response.result[item.id];
                    if (translation && item.el.isConnected) {
                        renderTranslation(item.el, item.text, translation);
                        translationContext.push({
                            original: item.text.slice(0, 80),
                            translated: translation.slice(0, 80)
                        });
                        if (translationContext.length > 6) translationContext.shift();
                    } else if (item.el.isConnected) {
                        item.el.setAttribute('data-yb-translated', 'failed');
                    }
                }
            }
        } catch (err) {
            validBatch.forEach(item => {
                if (item.el.isConnected) {
                    item.el.setAttribute('data-yb-translated', 'failed');
                }
            });
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────────

    function renderTranslation(el, originalText, translatedText) {
        el.setAttribute('data-yb-translated', 'done');
        el.classList.add('yb-web-original');

        // Wrap original words with colored spans
        el.innerHTML = tokenizeEnglishHTML(originalText, settings);

        // Build and insert translation block
        const translBlock = document.createElement('div');
        translBlock.className = 'yb-web-translation';
        translBlock.setAttribute('data-yb-transl-for', el.getAttribute('data-yb-para-id'));
        translBlock.innerHTML = wrapTranslationSentences(translatedText);

        el.parentNode.insertBefore(translBlock, el.nextSibling);

        attachWordEvents(el, translBlock);
    }

    // ── Sentence splitting ───────────────────────────────────────────────────────

    function splitSentences(text) {
        const sentences = [];
        const re = /[^.!?]*[.!?]+["')\]]*\s*/g;
        let pos = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const t = m[0].trim();
            if (t) sentences.push({ text: t, start: m.index, end: m.index + m[0].length });
            pos = m.index + m[0].length;
        }
        if (pos < text.length) {
            const t = text.slice(pos).trim();
            if (t) sentences.push({ text: t, start: pos, end: text.length });
        }
        return sentences;
    }

    function wrapTranslationSentences(text) {
        const sentences = splitSentences(text);
        if (sentences.length <= 1) {
            return `<span class="yb-transl-sentence" data-sidx="0">${escapeHtml(text)}</span>`;
        }
        return sentences.map((s, i) =>
            `<span class="yb-transl-sentence" data-sidx="${i}">${escapeHtml(s.text)}</span>`
        ).join(' ');
    }

    // ── Word Tokenization ────────────────────────────────────────────────────────

    function tokenizeEnglishHTML(text, settings) {
        const level = settings?.proficiencyLevel || 'none';
        // Split on spaces and punctuation, preserving them
        const tokens = text.split(/(\s+|[^\w'-]+)/);
        let html = '';
        for (const token of tokens) {
            if (!token) continue;
            if (/^[\w'-]+$/.test(token) && /[a-zA-Z]/.test(token)) {
                const cls = getWordClass(token, level);
                html += `<span class="yb-word ${cls}" data-word="${escapeAttr(token.toLowerCase())}">${escapeHtml(token)}</span>`;
            } else {
                html += escapeHtml(token);
            }
        }
        return html;
    }

    function getWordClass(word, level) {
        if (!window.WordLevels) return 'yb-word-unknown';
        const w = word.toLowerCase().replace(/[^a-z'-]/g, '');
        if (!w) return '';
        const WL = window.WordLevels;
        const inPrimary = WL.primary.includes(w);
        const inMiddle = inPrimary || WL.middle.includes(w);
        const inHigh = inMiddle || WL.high.includes(w);
        const inCet4 = inHigh || WL.cet4.includes(w);
        const inCet6 = inCet4 || WL.cet6.includes(w);

        let known = false;
        if (level === 'primary') known = inPrimary;
        else if (level === 'middle') known = inMiddle;
        else if (level === 'high') known = inHigh;
        else if (level === 'cet4') known = inCet4;
        else if (level === 'cet6') known = inCet6;

        return known ? 'yb-word-known' : 'yb-word-unknown';
    }

    // ── Interaction ──────────────────────────────────────────────────────────────

    function attachWordEvents(originalEl) {
        originalEl.addEventListener('mouseover', onWordMouseOver);
        originalEl.addEventListener('mouseout', onWordMouseOut);
        originalEl.addEventListener('click', onWordClick);
    }

    function onWordMouseOver(e) {
        const wordEl = e.target.closest('.yb-word');
        if (!wordEl) return;

        if (ctrlHeld) {
            highlightSentence(wordEl);
        } else {
            clearSentenceHighlights();
            clearWordHighlight();
            wordEl.classList.add('yb-word-hover');
        }
    }

    function onWordMouseOut(e) {
        const wordEl = e.target.closest('.yb-word');
        if (!wordEl) return;
        wordEl.classList.remove('yb-word-hover');
        if (!ctrlHeld) clearSentenceHighlights();
    }

    function onWordClick(e) {
        const wordEl = e.target.closest('.yb-word');
        if (!wordEl) return;
        e.stopPropagation();

        const word = wordEl.getAttribute('data-word') || wordEl.textContent;
        const sentence = getWordSentence(wordEl);

        WordPopup.show(
            wordEl,
            word,
            sentence,
            settings.targetLanguage || 'en',
            settings.nativeLanguage || 'zh',
            settings
        );
    }

    // ── Sentence Highlight ───────────────────────────────────────────────────────

    function highlightSentence(wordEl) {
        clearSentenceHighlights();
        clearWordHighlight();

        const parentEl = wordEl.closest('[data-yb-translated]');
        if (!parentEl) return;

        const allWords = Array.from(parentEl.querySelectorAll('.yb-word'));
        const wordIdx = allWords.indexOf(wordEl);
        if (wordIdx < 0) return;

        const fullText = parentEl.innerText;
        const sentences = splitSentences(fullText);
        const charsBefore = allWords.slice(0, wordIdx).map(w => w.textContent).join(' ').length;

        // Which sentence index does this word fall in?
        let targetSentIdx = sentences.length - 1;
        for (let i = 0; i < sentences.length; i++) {
            if (sentences[i].end > charsBefore) { targetSentIdx = i; break; }
        }

        // Highlight all words in that sentence
        for (const w of allWords) {
            const before = allWords.slice(0, allWords.indexOf(w)).map(x => x.textContent).join(' ').length;
            let si = sentences.length - 1;
            for (let i = 0; i < sentences.length; i++) {
                if (sentences[i].end > before) { si = i; break; }
            }
            if (si === targetSentIdx) w.classList.add('yb-sentence-hover');
        }

        // Highlight corresponding translation sentence
        const paraId = parentEl.getAttribute('data-yb-para-id');
        const translBlock = document.querySelector(`.yb-web-translation[data-yb-transl-for="${paraId}"]`);
        if (translBlock) {
            const translSents = translBlock.querySelectorAll('.yb-transl-sentence');
            const idx = Math.min(targetSentIdx, translSents.length - 1);
            if (translSents[idx]) translSents[idx].classList.add('yb-translation-sentence-hover');
        }
    }

    function clearSentenceHighlights() {
        document.querySelectorAll('.yb-sentence-hover').forEach(el => el.classList.remove('yb-sentence-hover'));
        document.querySelectorAll('.yb-translation-sentence-hover').forEach(el => el.classList.remove('yb-translation-sentence-hover'));
    }

    function clearWordHighlight() {
        document.querySelectorAll('.yb-word-hover').forEach(el => el.classList.remove('yb-word-hover'));
    }

    function getWordSentence(wordEl) {
        const parentEl = wordEl.closest('[data-yb-translated]');
        if (!parentEl) return wordEl.textContent;
        const allWords = Array.from(parentEl.querySelectorAll('.yb-word'));
        const wordIdx = allWords.indexOf(wordEl);
        const charsBefore = allWords.slice(0, wordIdx).map(w => w.textContent).join(' ').length;
        const fullText = parentEl.innerText;
        for (const s of splitSentences(fullText)) {
            if (s.end > charsBefore) return s.text;
        }
        return fullText.slice(0, 120);
    }

    // ── Progress Indicator ───────────────────────────────────────────────────────

    function showIndicator(text) {
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'yb-web-indicator';
            indicator.className = 'yb-web-translating-indicator';
            document.body.appendChild(indicator);
        }
        indicator.textContent = '🌐 ' + text;
        indicator.style.display = 'flex';
    }

    function updateIndicator(text) {
        if (indicator) indicator.textContent = '🌐 ' + text;
    }

    function removeIndicator() {
        if (indicator) indicator.style.display = 'none';
    }

    // ── Utilities ─────────────────────────────────────────────────────────────────

    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        return str.replace(/"/g, '&quot;');
    }

    // ── Boot ─────────────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }

})();
