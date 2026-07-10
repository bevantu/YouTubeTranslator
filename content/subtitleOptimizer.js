/**
 * Subtitle Optimizer Patch
 *
 * Loaded after content/subtitle.js and before content/content.js.
 * It patches SubtitleManager in-place so we can fix subtitle readability,
 * source/translation alignment, seek-aware pretranslation, and per-frame lookup
 * performance without rewriting the whole original file.
 */
(function () {
    'use strict';

    if (typeof SubtitleManager === 'undefined') {
        console.warn('[YT Bilingual Optimizer] SubtitleManager is not available.');
        return;
    }
    if (SubtitleManager.__ybOptimizerInstalled) return;
    SubtitleManager.__ybOptimizerInstalled = true;

    const M = SubtitleManager;

    const originalLoadTimedText = M.loadTimedText ? M.loadTimedText.bind(M) : null;
    const originalSetupCaptions = M._setupCaptions ? M._setupCaptions.bind(M) : null;
    const originalUpdateSettings = M.updateSettings ? M.updateSettings.bind(M) : null;
    const originalDestroy = M.destroy ? M.destroy.bind(M) : null;

    const DISPLAY_RULES = {
        minChars: 18,
        targetChars: 46,
        softMaxChars: 62,
        hardMaxChars: 78,
        maxDurationMs: 3800,
        minDurationMs: 850,
        gapBreakMs: 420,
        holdSmallGapMs: 280,
        nativeOverlapRatio: 0.22
    };
    const MAX_BLOCK_FAILURES = 2;

    function cleanText(text) {
        return String(text || '')
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^\s*[>»]+\s*/, '')
            .trim();
    }

    function normalizeLanguageCode(lang) {
        return String(lang || '').trim().toLowerCase().replace('_', '-').split('-')[0];
    }

    function isNoSpaceLanguage(lang) {
        return ['zh', 'ja', 'th', 'km', 'lo', 'my'].includes(normalizeLanguageCode(lang));
    }

    function splitWords(text, lang = '') {
        const t = cleanText(text);
        if (!t) return [];
        if (isNoSpaceLanguage(lang)) {
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                try {
                    return Array.from(new Intl.Segmenter(lang || undefined, { granularity: 'grapheme' }).segment(t), x => x.segment);
                } catch { /* fall through */ }
            }
            return Array.from(t);
        }
        return t.split(/\s+/).filter(Boolean);
    }

    function joinTokens(tokens, lang = '') {
        if (isNoSpaceLanguage(lang)) return tokens.join('');
        return tokens.join(' ');
    }

    function endsSentence(text) {
        return /[.!?。！？…]["'”’）\])}]*$/.test(cleanText(text));
    }

    function endsSoft(text) {
        return /[,;:，；：、]["'”’）\])}]*$/.test(cleanText(text));
    }

    function startsContinuation(text) {
        const s = cleanText(text).toLowerCase();
        if (!s) return false;
        if (M.startsWithContinuationWord) {
            try { return !!M.startsWithContinuationWord(s); } catch { /* ignore */ }
        }
        return /^(and|or|but|so|because|as|while|although|though|then|that|which|who|when|where|with|without|for|to|of|in|on|at|by|from|以及|但是|因为|所以|而且|然后|如果|虽然)/i.test(s);
    }

    function canBreak(text) {
        const s = cleanText(text);
        if (!s) return false;
        if (endsSentence(s) || endsSoft(s)) return true;
        if (M.canBreakDisplaySegment) {
            try { return !!M.canBreakDisplaySegment(s); } catch { /* ignore */ }
        }
        return true;
    }

    function suffixPrefixWordOverlap(prev, curr, lang = '') {
        const a = splitWords(prev, lang).map(x => x.toLowerCase());
        const b = splitWords(curr, lang).map(x => x.toLowerCase());
        const max = Math.min(a.length, b.length, isNoSpaceLanguage(lang) ? 80 : 20);
        for (let len = max; len > 0; len--) {
            if (a.slice(-len).join('\u0001') === b.slice(0, len).join('\u0001')) return len;
        }
        return 0;
    }

    function extractRollingDelta(prevFullText, currentText, lang = '') {
        const prev = cleanText(prevFullText);
        const curr = cleanText(currentText);
        if (!curr) return { text: '', overlap: 0, restarted: false };
        if (!prev) return { text: curr, overlap: 0, restarted: true };

        const prevLower = prev.toLowerCase();
        const currLower = curr.toLowerCase();
        if (currLower === prevLower) {
            return { text: '', overlap: splitWords(curr, lang).length, restarted: false };
        }
        if (currLower.startsWith(prevLower)) {
            return {
                text: cleanText(curr.slice(prev.length)),
                overlap: splitWords(prev, lang).length,
                restarted: false
            };
        }

        const currWords = splitWords(curr, lang);
        const overlap = suffixPrefixWordOverlap(prev, curr, lang);
        if (overlap > 0) {
            return {
                text: overlap < currWords.length ? cleanText(joinTokens(currWords.slice(overlap), lang)) : '',
                overlap,
                restarted: false
            };
        }

        return { text: curr, overlap: 0, restarted: true };
    }

    function extractNewText(prevFullText, currentText, lang = '') {
        return extractRollingDelta(prevFullText, currentText, lang).text;
    }

    function parseTimedTextEvents(json) {
        if (!json || !Array.isArray(json.events)) return [];

        const raw = [];
        for (const ev of json.events) {
            if (ev.tStartMs == null || !ev.segs) continue;
            const text = cleanText(ev.segs.map(s => (s.utf8 || '').replace(/\n/g, ' ')).join(''));
            if (!text) continue;
            const startMs = Number(ev.tStartMs) || 0;
            const duration = Number(ev.dDurationMs) || 1600;
            raw.push({ startMs, endMs: startMs + Math.max(250, duration), text });
        }
        if (!raw.length) return [];

        raw.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

        // Deduplicate identical starts; keep the most informative text.
        const byStart = new Map();
        for (const e of raw) {
            const existing = byStart.get(e.startMs);
            if (!existing || e.text.length > existing.text.length) byStart.set(e.startMs, e);
        }
        const events = Array.from(byStart.values()).sort((a, b) => a.startMs - b.startMs);

        return events;
    }

    function isRollingCaptionTrack(events, lang = '', hintAuto = false) {
        if (!events || events.length < 2) return false;
        let comparable = 0;
        let rolling = 0;
        for (let i = 1; i < events.length; i++) {
            const prev = cleanText(events[i - 1].text);
            const curr = cleanText(events[i].text);
            if (!prev || !curr) continue;
            comparable++;
            const p = prev.toLowerCase();
            const c = curr.toLowerCase();
            const overlap = suffixPrefixWordOverlap(prev, curr, lang);
            const minimumOverlap = isNoSpaceLanguage(lang) ? 2 : 1;
            if ((c.startsWith(p) && curr.length > prev.length) || overlap >= minimumOverlap) {
                rolling++;
            }
        }
        const minComparable = hintAuto ? 1 : 3;
        return comparable >= minComparable && rolling / comparable >= (hintAuto ? 0.28 : 0.45);
    }

    function eventsToAtoms(events, options = {}) {
        const lang = options.lang || '';
        const rolling = options.forceRolling != null
            ? options.forceRolling
            : isRollingCaptionTrack(events, lang, !!options.hintAuto);
        const atoms = [];
        let prevFullText = '';

        for (const ev of events) {
            let newText = rolling ? extractNewText(prevFullText, ev.text, lang) : ev.text;
            newText = cleanText(newText);
            if (newText) {
                atoms.push({ startMs: ev.startMs, endMs: ev.endMs, text: newText });
            }
            prevFullText = ev.text;
        }
        return atoms;
    }

    function splitLongTextIntoChunks(text, maxChars) {
        const cleaned = cleanText(text);
        if (cleaned.length <= maxChars) return [cleaned];

        const words = splitWords(cleaned);
        if (!words.length) return [cleaned];

        const chunks = [];
        let current = [];
        for (const word of words) {
            const candidate = joinTokens(current.concat(word), cleaned);
            if (current.length && candidate.length > maxChars) {
                chunks.push(joinTokens(current, cleaned));
                current = [word];
            } else {
                current.push(word);
            }
        }
        if (current.length) chunks.push(joinTokens(current, cleaned));
        return chunks.filter(Boolean);
    }

    function pushCue(cues, text, startMs, endMs, breakReason) {
        const cleaned = cleanText(text);
        if (!cleaned) return;
        const duration = Math.max(250, endMs - startMs);
        const chunks = splitLongTextIntoChunks(cleaned, DISPLAY_RULES.hardMaxChars);

        if (chunks.length === 1) {
            cues.push({
                id: `cue_${cues.length}_${Math.round(startMs)}_${Math.round(endMs)}`,
                startMs,
                endMs,
                text: chunks[0],
                translation: null,
                displayBreakReason: breakReason,
                translateContext: '',
                translateBlockId: '',
                translateBlockIndex: -1
            });
            return;
        }

        let cursor = startMs;
        const totalChars = chunks.reduce((sum, c) => sum + Math.max(1, c.length), 0);
        chunks.forEach((chunk, idx) => {
            const share = Math.max(250, duration * (Math.max(1, chunk.length) / totalChars));
            const chunkStart = cursor;
            const chunkEnd = idx === chunks.length - 1 ? endMs : Math.min(endMs, cursor + share);
            cursor = chunkEnd;
            cues.push({
                id: `cue_${cues.length}_${Math.round(chunkStart)}_${Math.round(chunkEnd)}`,
                startMs: chunkStart,
                endMs: chunkEnd,
                text: chunk,
                translation: null,
                displayBreakReason: `${breakReason || 'split'}-long`,
                translateContext: '',
                translateBlockId: '',
                translateBlockIndex: -1
            });
        });
    }

    function buildDisplayCues(atoms) {
        const cues = [];
        let segText = '';
        let segStart = 0;
        let segEnd = 0;

        const flush = (reason) => {
            if (segText.trim()) pushCue(cues, segText, segStart, segEnd, reason);
            segText = '';
            segStart = 0;
            segEnd = 0;
        };

        for (let i = 0; i < atoms.length; i++) {
            const atom = atoms[i];
            const atomText = cleanText(atom.text);
            if (!atomText) continue;
            const gap = segText ? atom.startMs - segEnd : 0;

            if (segText && gap > DISPLAY_RULES.gapBreakMs) {
                flush('gap');
            }

            const candidate = segText ? `${segText} ${atomText}` : atomText;
            if (
                segText &&
                candidate.length > DISPLAY_RULES.hardMaxChars &&
                !startsContinuation(atomText) &&
                segText.length >= DISPLAY_RULES.minChars
            ) {
                flush('hard-before-next');
            }

            if (!segText) {
                segStart = atom.startMs;
                segText = atomText;
            } else {
                segText += ' ' + atomText;
            }
            segEnd = atom.endMs;

            const trimmed = cleanText(segText);
            const duration = segEnd - segStart;
            const nextAtom = atoms[i + 1] || null;
            const nextGap = nextAtom ? nextAtom.startMs - segEnd : 9999;
            const nextStartsContinuation = nextAtom ? startsContinuation(nextAtom.text) : false;

            if (trimmed.length >= DISPLAY_RULES.minChars && endsSentence(trimmed)) {
                flush('sentence');
            } else if (trimmed.length >= DISPLAY_RULES.softMaxChars && canBreak(trimmed) && !nextStartsContinuation) {
                flush('soft');
            } else if (trimmed.length >= DISPLAY_RULES.targetChars && nextGap > 120 && canBreak(trimmed) && !nextStartsContinuation) {
                flush('soft-gap');
            } else if (duration >= DISPLAY_RULES.maxDurationMs && trimmed.length >= DISPLAY_RULES.minChars && !nextStartsContinuation) {
                flush('duration');
            } else if (trimmed.length >= DISPLAY_RULES.hardMaxChars) {
                flush('hard');
            }
        }
        flush('tail');

        // Keep tiny pauses connected, but do not stretch subtitles across real silence.
        for (let i = 0; i < cues.length - 1; i++) {
            const gap = cues[i + 1].startMs - cues[i].endMs;
            if (gap > 0 && gap <= DISPLAY_RULES.holdSmallGapMs) {
                cues[i].endMs = cues[i + 1].startMs;
            }
        }

        // Ensure a readable minimum display duration where possible.
        for (let i = 0; i < cues.length; i++) {
            const nextStart = cues[i + 1]?.startMs ?? Infinity;
            if (cues[i].endMs - cues[i].startMs < DISPLAY_RULES.minDurationMs) {
                cues[i].endMs = Math.min(nextStart, cues[i].startMs + DISPLAY_RULES.minDurationMs);
            }
        }
        return cues;
    }

    function createDisplayCue(event, index, text = event.text, extra = {}) {
        return {
            id: 'cue_' + index + '_' + Math.round(event.startMs) + '_' + Math.round(event.endMs),
            startMs: event.startMs,
            endMs: Math.max(event.startMs + 1, event.endMs),
            text: cleanText(text),
            translation: null,
            nativeTranslation: null,
            displayBreakReason: extra.displayBreakReason || 'source-cue',
            translateContext: '',
            translateBlockId: '',
            translateBlockIndex: -1,
            sourceEventIndex: extra.sourceEventIndex ?? index,
            rollingGroupId: extra.rollingGroupId || '',
            isRollingSnapshot: !!extra.isRollingSnapshot,
            sourceLanguage: extra.sourceLanguage || ''
        };
    }

    function buildSourceTimedCues(events) {
        return (events || []).map((event, index) => createDisplayCue(event, index, event.text, {
            sourceLanguage: event.sourceLanguage || ''
        }));
    }

    /**
     * Build rolling snapshots at the moment each piece of text becomes available.
     * A snapshot may repeat already-visible words, but it never contains words from
     * a later event. Translation grouping is added separately afterwards.
     */
    function buildRollingTimedCues(events, lang = '') {
        const cues = [];
        let phrase = '';
        let previousFullText = '';
        let previousEvent = null;
        let resetBeforeNext = false;
        let groupIndex = 0;

        for (let index = 0; index < events.length; index++) {
            const event = events[index];
            const next = events[index + 1] || null;
            const gap = previousEvent ? event.startMs - previousEvent.endMs : 0;
            const delta = extractRollingDelta(previousFullText, event.text, lang);

            if (gap > DISPLAY_RULES.gapBreakMs || resetBeforeNext || delta.restarted) {
                phrase = '';
                if (index > 0) groupIndex++;
                resetBeforeNext = false;
            }

            if (delta.text) {
                phrase = phrase
                    ? joinTokens([phrase, delta.text], lang)
                    : delta.text;
            }

            // A repeated or shortened rolling window carries the previous visible
            // phrase forward; it must not add the same words again.
            if (!phrase) phrase = cleanText(event.text);

            const visibleEnd = next && next.startMs < event.endMs
                ? next.startMs
                : event.endMs;
            const normalizedEvent = { ...event, endMs: Math.max(event.startMs + 1, visibleEnd) };
            const previousCue = cues[cues.length - 1];
            const rollingGroupId = 'rolling_' + groupIndex;

            if (
                previousCue &&
                previousCue.text === phrase &&
                previousCue.rollingGroupId === rollingGroupId &&
                previousCue.endMs <= event.startMs + DISPLAY_RULES.holdSmallGapMs
            ) {
                previousCue.endMs = normalizedEvent.endMs;
            } else {
                cues.push(createDisplayCue(normalizedEvent, cues.length, phrase, {
                    displayBreakReason: 'rolling-snapshot',
                    sourceEventIndex: index,
                    rollingGroupId,
                    isRollingSnapshot: true,
                    sourceLanguage: lang
                }));
            }

            const phraseDuration = event.endMs - (cues[cues.length - 1]?.startMs ?? event.startMs);
            resetBeforeNext = endsSentence(phrase) ||
                phrase.length >= DISPLAY_RULES.hardMaxChars ||
                phraseDuration >= DISPLAY_RULES.maxDurationMs;
            previousFullText = event.text;
            previousEvent = event;
        }

        return cues;
    }

    function buildTimedDisplayCues(events, options = {}) {
        const lang = options.lang || '';
        const rolling = options.forceRolling != null
            ? options.forceRolling
            : isRollingCaptionTrack(events, lang, !!options.hintAuto);
        return rolling ? buildRollingTimedCues(events, lang) : buildSourceTimedCues(events);
    }

    function dedupeJoinedText(parts, lang = '') {
        const out = [];
        for (const raw of parts) {
            const part = cleanText(raw);
            if (!part) continue;
            const last = out[out.length - 1] || '';
            if (!last) {
                out.push(part);
                continue;
            }
            if (last === part || last.endsWith(part)) continue;
            if (part.startsWith(last)) {
                out[out.length - 1] = part;
                continue;
            }
            out.push(part);
        }
        return isNoSpaceLanguage(lang) ? out.join('') : out.join(' ');
    }

    function alignNativeTranslations(displayCues, transJson, lang = '') {
        const translatedEvents = parseTimedTextEvents(transJson);
        if (!translatedEvents.length) return displayCues;
        const translatedAtoms = eventsToAtoms(translatedEvents, { lang });
        const toleranceMs = 220;

        for (const cue of displayCues) {
            const parts = [];
            for (const t of translatedAtoms) {
                const overlap = Math.min(cue.endMs, t.endMs) - Math.max(cue.startMs, t.startMs);
                const tDur = Math.max(1, t.endMs - t.startMs);
                const cueDur = Math.max(1, cue.endMs - cue.startMs);
                const startDistance = Math.abs(t.startMs - cue.startMs);
                const centerDistance = Math.abs((t.startMs + t.endMs) / 2 - (cue.startMs + cue.endMs) / 2);
                const overlapRatio = Math.max(0, overlap) / Math.min(tDur, cueDur);
                if (
                    overlapRatio >= DISPLAY_RULES.nativeOverlapRatio ||
                    startDistance <= toleranceMs ||
                    centerDistance <= toleranceMs
                ) {
                    parts.push(t.text);
                }
            }
            if (!parts.length) {
                let nearest = null;
                let nearestDistance = Infinity;
                for (const t of translatedAtoms) {
                    const distance = Math.abs(t.startMs - cue.startMs);
                    if (distance < nearestDistance) {
                        nearest = t;
                        nearestDistance = distance;
                    }
                }
                if (nearest && nearestDistance <= 450) parts.push(nearest.text);
            }
            const joined = dedupeJoinedText(parts, lang);
            cue.nativeTranslation = joined || null;
            cue.translation = cue.nativeTranslation;
        }
        return displayCues;
    }

    function buildTranslationBlocks(cues, generation = 0) {
        const blocks = [];
        let current = [];

        const flush = () => {
            if (!current.length) return;
            const blockIndex = blocks.length;
            const blockId = `block_${generation}_${blockIndex}_${Math.round(current[0].startMs)}_${Math.round(current[current.length - 1].endMs)}`;
            const lang = current[0]?.sourceLanguage || '';
            const context = dedupeJoinedText(current.map(c => c.text), lang);
            current.forEach((cue, idx) => {
                cue.translateContext = context;
                cue.translateBlockId = blockId;
                cue.translateBlockIndex = blockIndex;
                cue.translateSegmentIndex = idx;
            });
            blocks.push({
                id: blockId,
                index: blockIndex,
                startMs: current[0].startMs,
                cues: current.slice(),
                text: context,
                original: context,
                translated: ''
            });
            current = [];
        };

        for (const cue of cues) {
            if (current.length) {
                const prev = current[current.length - 1];
                const nextBlockText = dedupeJoinedText(current.map(c => c.text).concat(cue.text), cue.sourceLanguage || '');
                const gap = cue.startMs - prev.endMs;
                const shouldSplit =
                    gap > DISPLAY_RULES.gapBreakMs ||
                    endsSentence(prev.text) ||
                    current.length >= 4 ||
                    nextBlockText.length > 320;
                if (shouldSplit && !startsContinuation(cue.text)) flush();
            }
            current.push(cue);
        }
        flush();
        return blocks;
    }

    function normalizeTranslationForDisplay(text) {
        return cleanText(text)
            .replace(/^<FINAL>/i, '')
            .replace(/<\/FINAL>$/i, '')
            .replace(/^\s*(?:\[\d+\]|\d+[.)、：:]?)\s*/, '')
            .trim();
    }

    function emitManagerEvent(name, detail) {
        if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
        try {
            const event = typeof CustomEvent === 'function'
                ? new CustomEvent(name, { detail })
                : { type: name, detail };
            document.dispatchEvent(event);
        } catch { /* page lifecycle may already be ending */ }
    }

    function captionStatus(cue) {
        if (cue?.translation === '__pending__') return 'pending';
        if (cue?.translation) return 'ready';
        if (cue?.translationError) return 'error';
        return 'untranslated';
    }

    function emitCaptionsReady(manager) {
        const generation = manager._ybGeneration || 0;
        emitManagerEvent('yb-captions-ready', {
            generation,
            captions: (manager.captions || []).map((cue, index) => ({
                index,
                id: cue.id,
                startMs: cue.startMs,
                endMs: cue.endMs,
                text: cue.text,
                translation: cue.translation && cue.translation !== '__pending__' ? cue.translation : '',
                status: captionStatus(cue)
            }))
        });
    }

    function emitSubtitleStatus(manager, state, details = {}) {
        emitManagerEvent('yb-subtitle-status', {
            generation: manager._ybGeneration || 0,
            state,
            message: details.message || '',
            error: details.error || '',
            fallback: details.fallback || ''
        });
    }

    function canonicalTrackMeta(manager, url) {
        const base = manager.extractTimedTextMeta ? manager.extractTimedTextMeta(url) : {};
        try {
            const parsed = new URL(url.startsWith('/') ? window.location.origin + url : url);
            return {
                ...base,
                lang: parsed.searchParams.get('lang') || base.lang || '',
                tlang: parsed.searchParams.get('tlang') || base.tlang || '',
                kind: parsed.searchParams.get('kind') || base.kind || '',
                name: parsed.searchParams.get('name') || base.name || '',
                vssId: parsed.searchParams.get('vssId') || parsed.searchParams.get('vssid') || base.vssId || '',
                fmt: parsed.searchParams.get('fmt') || base.fmt || '',
                videoId: parsed.searchParams.get('v') || '',
                url: parsed.toString()
            };
        } catch {
            return { ...base, url: url || '', videoId: '' };
        }
    }

    function trackScore(meta, settings) {
        const wanted = normalizeLanguageCode(settings?.targetLanguage);
        const actual = normalizeLanguageCode(meta?.lang);
        let score = meta?.tlang ? -120 : 40;
        if (wanted && actual) score += wanted === actual ? 220 : -120;
        else if (!actual) score -= 10;
        if (meta?.kind === 'asr' || String(meta?.vssId || '').startsWith('a.')) score += 5;
        else score += 25;
        if (!meta?.name) score += 3;
        return score;
    }

    function trackKey(meta) {
        return [meta?.videoId || '', meta?.lang || '', meta?.kind || '', meta?.name || '', meta?.vssId || ''].join('|');
    }

    function translationSettingsKey(settings) {
        const s = settings || {};
        return [
            s.targetLanguage || '', s.nativeLanguage || '', !!s.autoTranslate,
            !!s.useAITranslation, s.aiProvider || '', s.apiEndpoint || '',
            s.apiModel || '', s.localEndpoint || '', s.localModel || ''
        ].join('|');
    }

    function invalidateGeneration(manager, lifecycleChange = false) {
        if (lifecycleChange) manager._ybLifecycleEpoch = (manager._ybLifecycleEpoch || 0) + 1;
        manager._ybGeneration = (manager._ybGeneration || 0) + 1;
        manager.translationAbortKey = (manager.translationAbortKey || 0) + 1;
        manager.preTranslating = false;
        manager.needsPriorityPreTranslation = false;
        if (manager.priorityTimerId) clearTimeout(manager.priorityTimerId);
        manager.priorityTimerId = null;
        if (manager.warmupTimerId) clearTimeout(manager.warmupTimerId);
        manager.warmupTimerId = null;
        manager.pendingBlockTranslations?.clear();
        return manager._ybGeneration;
    }

    function blockFullyTranslated(block) {
        return !!block && block.cues.every(c => c.translation && c.translation !== '__pending__');
    }

    function findBlockById(manager, blockId) {
        return (manager.translationBlocks || []).find(b => b.id === blockId || b.blockId === blockId);
    }

    function isPlaybackPriorityBlock(manager, block) {
        if (!block) return false;
        const video = typeof document !== 'undefined' ? document.querySelector('video') : null;
        const currentMs = (video?.currentTime || 0) * 1000;
        const activeIndex = manager.findCurrentCaptionIndex?.(currentMs) ?? -1;
        const priorityCue = activeIndex >= 0
            ? manager.captions?.[activeIndex]
            : (manager.captions || []).find(cue => cue.endMs > currentMs);
        return priorityCue?.translateBlockId === (block.id || block.blockId);
    }

    function recordBlockFailure(manager, block, error) {
        if (!block) return;
        if (error?.stale || ['STALE_TRANSLATION_TASK', 'REQUEST_CANCELLED'].includes(error?.code)) return;
        if (block.lastFailureError === error) return;
        block.lastFailureError = error;
        const retryable = error?.retryable !== false;
        block.failureCount = retryable
            ? (block.failureCount || 0) + 1
            : MAX_BLOCK_FAILURES;
        const exhausted = block.failureCount >= MAX_BLOCK_FAILURES;
        const delay = Math.min(30000, 1500 * (2 ** Math.min(4, block.failureCount - 1)));
        block.retryAt = exhausted ? Infinity : Date.now() + delay;
        for (const cue of block.cues || []) {
            if (cue.translation === '__pending__') cue.translation = null;
            cue.translationError = error?.message || 'Translation unavailable';
            const index = manager.captions?.indexOf(cue) ?? -1;
            emitManagerEvent('yb-caption-translation', {
                generation: manager._ybGeneration || 0,
                index,
                id: cue.id,
                translation: '',
                status: 'error',
                error: cue.translationError
            });
        }
        if (isPlaybackPriorityBlock(manager, block)) {
            emitSubtitleStatus(manager, exhausted ? 'translation-unavailable' : 'translation-error', {
                message: exhausted
                    ? 'Translation is temporarily unavailable for this subtitle.'
                    : `Translation will retry in ${Math.ceil(delay / 1000)} seconds.`,
                error: error?.message || 'Translation unavailable',
                fallback: exhausted ? 'source-only' : 'retry'
            });
        }
    }

    if (typeof TranslatorService !== 'undefined' && !TranslatorService.translateStructuredBlock) {
        TranslatorService.translateStructuredBlock = async function (segments, targetLang, nativeLang, settings, context = []) {
            const response = await chrome.runtime.sendMessage({
                action: 'translateStructuredBlock',
                segments,
                targetLang,
                nativeLang,
                settings,
                context
            });
            if (response?.success) return response.result || {};
            throw new Error(response?.error || 'Structured block translation failed');
        };
    }

    M.parseJSON3 = function optimizedParseJSON3(json, transJson = null) {
        const events = parseTimedTextEvents(json);
        if (!events.length) return [];
        const meta = this._ybParsingMeta || {};
        const lang = meta.lang || this.settings?.targetLanguage || '';
        events.forEach(event => { event.sourceLanguage = lang; });
        let displayCues = buildTimedDisplayCues(events, {
            lang,
            hintAuto: meta.kind === 'asr' || String(meta.vssId || '').startsWith('a.')
        });
        if (transJson) displayCues = alignNativeTranslations(displayCues, transJson, this.settings?.nativeLanguage || '');
        console.log(`[YT Bilingual Optimizer] ${events.length} raw events → ${displayCues.length} source-timed display cues.`);
        return displayCues;
    };

    M.parseXML = function optimizedParseXML(xml) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, 'text/xml');
            const events = Array.from(doc.querySelectorAll('text')).map(el => {
                const startMs = parseFloat(el.getAttribute('start') || '0') * 1000;
                const durMs = parseFloat(el.getAttribute('dur') || '1.6') * 1000;
                return {
                    startMs,
                    endMs: startMs + Math.max(250, durMs),
                    text: cleanText(el.textContent || '')
                };
            }).filter(e => e.text).sort((a, b) => a.startMs - b.startMs);
            const lang = this._ybParsingMeta?.lang || this.settings?.targetLanguage || '';
            events.forEach(event => { event.sourceLanguage = lang; });
            const cues = buildSourceTimedCues(events);
            console.log(`[YT Bilingual Optimizer] XML ${events.length} raw events → ${cues.length} source-timed display cues.`);
            return cues;
        } catch (err) {
            console.warn('[YT Bilingual Optimizer] XML parse failed:', err);
            return [];
        }
    };

    M.collectTranslationBlocks = function optimizedCollectTranslationBlocks(entries) {
        return buildTranslationBlocks(entries || [], this._ybGeneration || 0);
    };

    M.loadTimedText = async function optimizedLoadTimedText(rawText, url) {
        const lifecycleEpoch = this._ybLifecycleEpoch || 0;
        let requestMeta = canonicalTrackMeta(this, url || '');
        let baseRaw = rawText;
        let baseJson = null;
        let transJson = null;
        let companionFallback = '';
        const needsOriginalFetch = Boolean(url && requestMeta.tlang);
        const isJson = (url && url.includes('fmt=json3')) || /^\s*\{/.test(rawText || '');

        try {
            if (isJson) baseJson = JSON.parse(rawText);
            if (url && requestMeta.tlang) {
                const originalUrl = new URL(requestMeta.url || url);
                originalUrl.searchParams.delete('tlang');
                if (this.settings?.autoTranslate && !this.settings?.useAITranslation) transJson = baseJson;
                const response = await fetch(originalUrl.toString());
                if (!response.ok) throw new Error(`Original subtitle request failed (${response.status}).`);
                baseRaw = await response.text();
                baseJson = isJson ? JSON.parse(baseRaw) : null;
                requestMeta = canonicalTrackMeta(this, originalUrl.toString());
            } else if (isJson && this.settings?.autoTranslate && !this.settings?.useAITranslation && url) {
                const translatedUrl = new URL(requestMeta.url || url);
                let tlang = this.settings.nativeLanguage;
                if (tlang === 'zh') tlang = 'zh-Hans';
                translatedUrl.searchParams.set('tlang', tlang);
                const response = await fetch(translatedUrl.toString());
                if (!response.ok) throw new Error(`Translated subtitle request failed (${response.status}).`);
                transJson = await response.json();
            }
        } catch (err) {
            console.warn('[YT Bilingual Optimizer] Timedtext companion track failed:', err);
            if (needsOriginalFetch) {
                this.hideNativeCaptions?.(false);
                emitSubtitleStatus(this, 'fallback', {
                    message: 'Could not recover the original subtitle track; using YouTube captions.',
                    fallback: 'youtube-captions'
                });
                return;
            }
            companionFallback = 'source-only';
        }

        if (lifecycleEpoch !== (this._ybLifecycleEpoch || 0)) return;
        try {
            const pageVideoId = typeof location !== 'undefined' ? new URL(location.href).searchParams.get('v') : '';
            if (requestMeta.videoId && pageVideoId && requestMeta.videoId !== pageVideoId) return;
        } catch { /* ignore malformed navigation URL */ }

        const candidateScore = trackScore(requestMeta, this.settings);
        const candidateKey = trackKey(requestMeta);
        const selected = this._ybSelectedTrack;
        if (
            selected &&
            (!requestMeta.videoId || !selected.videoId || selected.videoId === requestMeta.videoId) &&
            selected.key !== candidateKey &&
            selected.score >= candidateScore
        ) {
            return;
        }

        this._ybParsingMeta = requestMeta;
        let entries = [];
        if (isJson) {
            if (!baseJson) {
                try { baseJson = JSON.parse(baseRaw); } catch { return; }
            }
            entries = this.parseJSON3(baseJson, transJson);
        } else {
            entries = this.parseXML(baseRaw);
        }
        if (!entries.length) return;

        this._ybSelectedTrack = {
            key: candidateKey,
            score: candidateScore,
            videoId: requestMeta.videoId || '',
            meta: requestMeta
        };
        this._ybLastTimedText = { rawText: baseRaw, url: requestMeta.url || url };
        this._setupCaptions(entries, { ...requestMeta, companionFallback });
    };

    M._setupCaptions = function optimizedSetupCaptions(entries, requestMeta = null) {
        const fingerprint = this.buildCaptionFingerprint?.(entries, requestMeta) || '';
        if (fingerprint && fingerprint === this.currentCaptionFingerprint) return false;

        invalidateGeneration(this);
        this.currentCaptionIndex = -1;
        this.lastRenderedId = '';
        this.lastRenderedSignature = '';
        this.lastActiveEventIndex = -2;
        this.captions = entries;
        this.contextBuffer = [];
        this.translationBlocks = buildTranslationBlocks(entries, this._ybGeneration);
        this.currentCaptionFingerprint = fingerprint;
        this.currentCaptionMeta = requestMeta;
        this.hideNativeCaptions?.(true);
        emitCaptionsReady(this);

        const wantsAI = Boolean(this.settings?.autoTranslate && this.settings?.useAITranslation);
        const wantsNativeTranslation = Boolean(this.settings?.autoTranslate && !this.settings?.useAITranslation);
        const nativeTranslationAvailable = entries.some(cue => Boolean(cue.nativeTranslation || cue.translation));
        const actualLanguage = normalizeLanguageCode(requestMeta?.lang);
        const wantedLanguage = normalizeLanguageCode(this.settings?.targetLanguage);
        const languageMismatch = Boolean(actualLanguage && wantedLanguage && actualLanguage !== wantedLanguage);

        if (requestMeta?.companionFallback || (wantsNativeTranslation && !nativeTranslationAvailable)) {
            emitSubtitleStatus(this, 'fallback', {
                message: 'Translation is unavailable; showing the original subtitles.',
                fallback: 'source-only'
            });
        } else if (wantsAI) {
            emitSubtitleStatus(this, languageMismatch ? 'fallback' : 'preparing', {
                message: languageMismatch
                    ? `Using ${actualLanguage} captions instead of ${wantedLanguage}; translating from the detected track.`
                    : `${entries.length} subtitles loaded; translating nearby lines?`,
                fallback: languageMismatch ? 'detected-language' : ''
            });
        } else {
            emitSubtitleStatus(this, 'ready', { message: `${entries.length} subtitles ready.` });
        }

        if (wantsAI && !this._ybTranslationPaused) {
            const runKey = this.translationAbortKey;
            this.warmupTimerId = setTimeout(() => {
                this.warmupTimerId = null;
                this.warmupAndTranslate(runKey);
            }, 120);
        }
        return true;
    };

    M.updateSettings = async function optimizedUpdateSettings(newSettings) {
        const previousKey = translationSettingsKey(this.settings);
        if (originalUpdateSettings) await originalUpdateSettings(newSettings);
        else this.settings = newSettings;
        const nextKey = translationSettingsKey(this.settings);

        if (previousKey !== nextKey) {
            const lastTimedText = this._ybLastTimedText;
            invalidateGeneration(this, true);
            this.currentCaptionFingerprint = '';
            this._ybSelectedTrack = null;
            for (const cue of this.captions || []) {
                cue.translation = this.settings?.autoTranslate && !this.settings?.useAITranslation
                    ? cue.nativeTranslation || null
                    : null;
                cue.translationError = '';
            }
            this.translationBlocks = buildTranslationBlocks(this.captions || [], this._ybGeneration);
            this.lastRenderedSignature = '';
            emitCaptionsReady(this);
            if (lastTimedText?.rawText) {
                await this.loadTimedText(lastTimedText.rawText, lastTimedText.url || '');
            }
        } else {
            this.lastRenderedSignature = '';
            const video = typeof document !== 'undefined' ? document.querySelector('video') : null;
            if (video) this.onTimeUpdate(video.currentTime);
        }
    };

    M.destroy = function optimizedDestroy() {
        invalidateGeneration(this, true);
        this._ybSelectedTrack = null;
        this._ybLastTimedText = null;
        this.lastActiveEventIndex = -2;
        if (this._ybBoundVideo && this._ybSeekHandler) {
            this._ybBoundVideo.removeEventListener('seeking', this._ybSeekHandler);
        }
        this._ybBoundVideo = null;
        emitManagerEvent('yb-caption-active', {
            generation: this._ybGeneration || 0,
            index: -1,
            id: '',
            startMs: null,
            endMs: null
        });
        emitSubtitleStatus(this, 'idle', { message: 'Subtitle session ended.' });
        return originalDestroy ? originalDestroy() : undefined;
    };

    M.setTranslationPaused = function setTranslationPaused(paused) {
        const next = Boolean(paused);
        if (this._ybTranslationPaused === next) return;
        this._ybTranslationPaused = next;
        invalidateGeneration(this);
        for (const cue of this.captions || []) {
            if (cue.translation === '__pending__') cue.translation = null;
        }
        this.translationBlocks = buildTranslationBlocks(this.captions || [], this._ybGeneration);
        this.lastRenderedSignature = '';
        emitCaptionsReady(this);

        if (!next && this.settings?.autoTranslate && this.settings?.useAITranslation) {
            emitSubtitleStatus(this, 'preparing', { message: 'Captions are on; resuming translation...' });
            this.schedulePriorityPreTranslation?.(this.translationAbortKey);
        }
    };

    M.findCurrentCaptionIndex = function optimizedFindCurrentCaptionIndex(ms) {
        const cues = this.captions || [];
        if (!cues.length) return -1;

        const i = Number.isInteger(this.currentCaptionIndex) ? this.currentCaptionIndex : -1;
        if (
            i >= 0 && i < cues.length &&
            ms >= cues[i].startMs && ms < cues[i].endMs &&
            (i + 1 >= cues.length || cues[i + 1].startMs > ms)
        ) {
            return i;
        }

        // Find the last cue whose start is not after the current time. This stays
        // logarithmic even after a long seek; for overlapping human cues, prefer
        // the most recently started one that is still active.
        let lo = 0;
        let hi = cues.length;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (mid < cues.length && cues[mid].startMs <= ms) lo = mid + 1;
            else hi = mid - 1;
        }
        for (let candidate = Math.min(cues.length - 1, lo - 1), checked = 0; candidate >= 0 && checked < 8; candidate--, checked++) {
            if (ms >= cues[candidate].startMs && ms < cues[candidate].endMs) {
                this.currentCaptionIndex = candidate;
                return candidate;
            }
            if (cues[candidate].endMs <= ms && candidate < lo - 1) break;
        }
        this.currentCaptionIndex = Math.max(-1, Math.min(cues.length - 1, lo - 1));
        return -1;
    };

    M.attachTimeupdateListener = function optimizedAttachTimeupdateListener() {
        const attach = () => {
            const video = document.querySelector('video');
            if (!video) { setTimeout(attach, 500); return; }

            if (this.rafId) cancelAnimationFrame(this.rafId);
            if (this._ybBoundVideo && this._ybSeekHandler) {
                this._ybBoundVideo.removeEventListener('seeking', this._ybSeekHandler);
            }
            this._ybSeekHandler = () => {
                this.currentCaptionIndex = -1;
                this.schedulePriorityPreTranslation?.(this.translationAbortKey);
            };
            this._ybBoundVideo = video;
            video.addEventListener('seeking', this._ybSeekHandler);

            const loop = () => {
                if (!this.subtitleContainer) return;
                const currentVideo = document.querySelector('video');
                if (currentVideo && currentVideo !== video) {
                    attach();
                    return;
                }
                this.onTimeUpdate(video.currentTime);
                this.rafId = requestAnimationFrame(loop);
            };
            this.rafId = requestAnimationFrame(loop);
        };
        attach();
    };

    M.onTimeUpdate = function optimizedOnTimeUpdate(currentTimeSec) {
        if (!this.captions?.length) return;
        const ms = currentTimeSec * 1000;
        const index = this.findCurrentCaptionIndex(ms);

        if (index < 0) {
            if (this.lastActiveEventIndex !== -1) {
                this.lastActiveEventIndex = -1;
                emitManagerEvent('yb-caption-active', {
                    generation: this._ybGeneration || 0,
                    index: -1,
                    id: '',
                    startMs: null,
                    endMs: null
                });
            }
            if (this.lastRenderedSignature !== '') {
                this.lastRenderedSignature = '';
                this.lastRenderedText = '';
                if (this.subtitleContainer) this.subtitleContainer.innerHTML = '';
            }
            return;
        }

        const entry = this.captions[index];
        if (this.lastActiveEventIndex !== index) {
            this.lastActiveEventIndex = index;
            emitManagerEvent('yb-caption-active', {
                generation: this._ybGeneration || 0,
                index,
                id: entry.id,
                startMs: entry.startMs,
                endMs: entry.endMs
            });
        }
        const block = findBlockById(this, entry.translateBlockId);
        const retryAllowed = !block || ((block.failureCount || 0) < MAX_BLOCK_FAILURES && (!block.retryAt || block.retryAt <= Date.now()));
        const needsTranslation = !!(
            !this._ybTranslationPaused &&
            this.settings?.autoTranslate &&
            this.settings?.useAITranslation &&
            entry.translation == null
        );
        const waitingToRetry = needsTranslation && !retryAllowed;
        const translation = entry.translation === '__pending__'
            ? null
            : (entry.translation || (waitingToRetry
                ? ((block?.failureCount || 0) >= MAX_BLOCK_FAILURES ? 'Translation unavailable' : 'Translation retrying…')
                : null));
        const loading = (needsTranslation && retryAllowed) || entry.translation === '__pending__';
        const signature = `${entry.id || entry.startMs}:${entry.text}:${translation || ''}:${loading}`;

        if (signature !== this.lastRenderedSignature) {
            this.lastRenderedSignature = signature;
            this.lastRenderedText = entry.text;
            this.renderSubtitle(entry.text, translation, loading);

        }

        if (needsTranslation && retryAllowed && entry.translateBlockId) {
            const generation = this._ybGeneration || 0;
            this.markBlockPending?.(entry.translateBlockId);
            this._translateBlock(entry.translateBlockId).then(() => {
                if (generation !== (this._ybGeneration || 0)) return;
                const currentIndex = this.findCurrentCaptionIndex((document.querySelector('video')?.currentTime || 0) * 1000);
                if (currentIndex >= 0 && this.captions[currentIndex]?.translateBlockId === entry.translateBlockId) {
                    this.lastRenderedSignature = '';
                    this.onTimeUpdate(document.querySelector('video')?.currentTime || currentTimeSec);
                }
            }).catch(err => {
                console.warn('[YT Bilingual Optimizer] Current block translation failed:', err);
                recordBlockFailure(this, findBlockById(this, entry.translateBlockId), err);
            });
        }

        this.schedulePriorityPreTranslation?.(this.translationAbortKey);
    };

    M.schedulePriorityPreTranslation = function schedulePriorityPreTranslation(runKey = this.translationAbortKey) {
        if (this._ybTranslationPaused || !(this.settings?.autoTranslate && this.settings?.useAITranslation)) return;
        if (this.priorityTimerId) return;
        this.priorityTimerId = setTimeout(() => {
            this.priorityTimerId = null;
            this.startPreTranslation(0, runKey);
        }, 160);
    };

    M.buildPriorityBlockQueue = function buildPriorityBlockQueue() {
        const blocks = this.translationBlocks || [];
        if (!blocks.length) return [];
        const video = document.querySelector('video');
        const currentMs = (video?.currentTime || 0) * 1000;
        const currentCueIndex = this.findCurrentCaptionIndex(currentMs);
        const fallbackCueIndex = Math.max(0, this.currentCaptionIndex || 0);
        const anchorCueIndex = currentCueIndex >= 0 ? currentCueIndex : fallbackCueIndex;
        const currentBlockIndex = this.captions[anchorCueIndex]?.translateBlockIndex ?? 0;
        const translateWholeVideo = this.settings?.preTranslateWholeVideo === true;

        return blocks
            .filter(block => !blockFullyTranslated(block))
            .filter(block => (block.failureCount || 0) < MAX_BLOCK_FAILURES)
            .filter(block => !block.retryAt || block.retryAt <= Date.now())
            .filter(block => translateWholeVideo || (
                (block.index ?? 0) >= Math.max(0, currentBlockIndex - 2) &&
                (block.startMs ?? 0) <= currentMs + 60000
            ))
            .map(block => {
                const distance = Math.abs((block.index ?? 0) - currentBlockIndex);
                const isFuture = (block.index ?? 0) >= currentBlockIndex;
                const priority = distance + (isFuture ? 0 : 3);
                return { block, priority };
            })
            .sort((a, b) => a.priority - b.priority)
            .map(x => x.block);
    };

    M.warmupAndTranslate = async function optimizedWarmupAndTranslate(runKey = this.translationAbortKey) {
        if (runKey !== this.translationAbortKey) return;
        // Do not pause the video. Translate near the current playback position first.
        this.startPreTranslation(0, runKey);
    };

    M.startPreTranslation = async function optimizedStartPreTranslation(_startFrom = 0, runKey = this.translationAbortKey) {
        if (this._ybTranslationPaused || runKey !== this.translationAbortKey) return;
        if (this.preTranslating) {
            this.needsPriorityPreTranslation = true;
            return;
        }

        this.preTranslating = true;
        try {
            do {
                this.needsPriorityPreTranslation = false;
                const queue = this.buildPriorityBlockQueue();
                const concurrency = this.settings?.aiProvider === 'local' ? 1 : 2;
                let cursor = 0;

                const worker = async () => {
                    while (cursor < queue.length && runKey === this.translationAbortKey) {
                        const block = queue[cursor++];
                        if (!block || blockFullyTranslated(block)) continue;
                        try {
                            await this._translateBlock(block.id);
                            block.failureCount = 0;
                            block.retryAt = 0;
                            block.lastFailureError = null;
                        } catch (err) {
                            recordBlockFailure(this, block, err);
                        }
                        await new Promise(r => setTimeout(r, 20));
                    }
                };

                await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
            } while (this.needsPriorityPreTranslation && runKey === this.translationAbortKey);
        } finally {
            this.preTranslating = false;
        }
    };

    M._translateBlock = async function optimizedTranslateBlock(blockId) {
        const block = findBlockById(this, blockId);
        if (this._ybTranslationPaused || !block || !block.cues?.length) return {};
        if (blockFullyTranslated(block)) {
            return Object.fromEntries(block.cues.map(c => [c.id, c.translation]));
        }
        if (this.pendingBlockTranslations?.has(blockId)) {
            return this.pendingBlockTranslations.get(blockId);
        }

        const generation = this._ybGeneration || 0;
        const settingsSnapshot = { ...(this.settings || {}) };
        const sourceLanguage = normalizeLanguageCode(this.currentCaptionMeta?.lang) || settingsSnapshot.targetLanguage;
        const taskRequest = {
            taskId: [
                generation,
                this.currentCaptionMeta?.videoId || '',
                trackKey(this.currentCaptionMeta || {})
            ].join(':'),
            taskScope: 'youtube-subtitles'
        };
        const isCurrent = () =>
            generation === (this._ybGeneration || 0) &&
            findBlockById(this, blockId) === block;

        const promise = (async () => {
            block.cues.forEach(cue => {
                if (cue.translation == null) cue.translation = '__pending__';
                if (cue.translation === '__pending__') {
                    emitManagerEvent('yb-caption-translation', {
                        generation,
                        index: this.captions.indexOf(cue),
                        id: cue.id,
                        translation: '',
                        status: 'pending',
                        error: ''
                    });
                }
            });

            const segments = block.cues.map((cue, idx) => {
                const globalIndex = this.captions.indexOf(cue);
                return {
                    id: cue.id,
                    numericId: idx + 1,
                    text: cue.text,
                    prevText: this.captions[globalIndex - 1]?.text || '',
                    nextText: this.captions[globalIndex + 1]?.text || '',
                    displayBreakReason: cue.displayBreakReason || ''
                };
            });

            let byCueId;
            if (typeof TranslatorService.translateStructuredBlock === 'function') {
                byCueId = await TranslatorService.translateStructuredBlock(
                    segments,
                    sourceLanguage,
                    settingsSnapshot.nativeLanguage,
                    settingsSnapshot,
                    this.contextBuffer || [],
                    taskRequest
                );
            } else {
                const numberedSegments = segments.map(s => ({
                    id: s.numericId,
                    text: s.text,
                    prevText: s.prevText,
                    nextText: s.nextText,
                    displayBreakReason: s.displayBreakReason
                }));
                const numbered = await TranslatorService.translateBlock(
                    numberedSegments,
                    sourceLanguage,
                    settingsSnapshot.nativeLanguage,
                    settingsSnapshot,
                    this.contextBuffer || [],
                    taskRequest
                );
                if (!isCurrent()) return {};
                byCueId = {};
                segments.forEach(s => {
                    if (numbered?.[s.numericId]) byCueId[s.id] = numbered[s.numericId];
                });
            }

            if (!isCurrent()) return {};
            const missingCueIds = segments
                .map(segment => segment.id)
                .filter(id => !normalizeTranslationForDisplay(byCueId?.[id] || ''));
            if (missingCueIds.length) {
                const error = new Error('Block translation returned incomplete lines.');
                error.code = 'INCOMPLETE_BLOCK_RESPONSE';
                error.retryable = true;
                error.details = { missingCueIds };
                throw error;
            }

            for (const cue of block.cues) {
                const translation = normalizeTranslationForDisplay(byCueId?.[cue.id] || '');
                if (!isCurrent()) return {};
                cue.translation = translation || null;
                cue.translationError = translation ? '' : 'Translation unavailable';

                const panelIndex = this.captions.indexOf(cue);
                emitManagerEvent('yb-caption-translation', {
                    generation,
                    index: panelIndex,
                    id: cue.id,
                    translation: cue.translation || '',
                    status: cue.translation ? 'ready' : 'error',
                    error: cue.translationError || ''
                });

                if (cue.translation) {
                    this.contextBuffer = this.contextBuffer || [];
                    this.contextBuffer.push({ original: cue.text.slice(0, 120), translated: cue.translation.slice(0, 120) });
                    while (this.contextBuffer.length > 8) this.contextBuffer.shift();
                    if (this.settings?.enableLogging && this.logBuffer) {
                        this.logBuffer.set(cue.text, { timeMs: cue.startMs, translated: cue.translation });
                    }
                }
            }

            block.translated = block.cues.every(cue => cue.translation)
                ? block.cues.map(cue => cue.translation).join(' ')
                : '';

            if (isPlaybackPriorityBlock(this, block)) {
                emitSubtitleStatus(this, 'ready', { message: 'Bilingual subtitles are ready.' });
            }

            return Object.fromEntries(block.cues.map(c => [c.id, c.translation]));
        })();

        this.pendingBlockTranslations = this.pendingBlockTranslations || new Map();
        this.pendingBlockTranslations.set(blockId, promise);
        try {
            return await promise;
        } finally {
            if (this.pendingBlockTranslations.get(blockId) === promise) {
                this.pendingBlockTranslations.delete(blockId);
            }
        }
    };

    if (typeof globalThis !== 'undefined') {
        globalThis.YBSubtitleOptimizerCore = {
            cleanText,
            normalizeLanguageCode,
            isNoSpaceLanguage,
            splitWords,
            joinTokens,
            suffixPrefixWordOverlap,
            extractNewText,
            extractRollingDelta,
            parseTimedTextEvents,
            isRollingCaptionTrack,
            buildSourceTimedCues,
            buildRollingTimedCues,
            buildTimedDisplayCues,
            alignNativeTranslations,
            buildTranslationBlocks,
            trackScore,
            trackKey
        };
    }

    console.log('[YT Bilingual Optimizer] Installed subtitle readability/alignment fixes.');
})();
