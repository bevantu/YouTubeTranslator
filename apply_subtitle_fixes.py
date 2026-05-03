#!/usr/bin/env python3
"""
Apply subtitle display/alignment/translation scheduling fixes to bevantu/YouTubeTranslator.
Run from the repository root:

    python3 apply_subtitle_fixes.py

The script is idempotent and creates *.bak.subtitlefix backups before modifying files.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path.cwd()

SUBTITLE_OPTIMIZER_JS = r'''/**
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

    function cleanText(text) {
        return String(text || '')
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^\s*[>»]+\s*/, '')
            .trim();
    }

    function hasCJK(text) {
        return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text || '');
    }

    function splitWords(text) {
        const t = cleanText(text);
        if (!t) return [];
        if (hasCJK(t) && !/\s/.test(t)) return Array.from(t);
        return t.split(/\s+/).filter(Boolean);
    }

    function joinTokens(tokens, referenceText) {
        if (hasCJK(referenceText) && !/\s/.test(referenceText)) return tokens.join('');
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

    function suffixPrefixWordOverlap(prev, curr) {
        const a = splitWords(prev).map(x => x.toLowerCase());
        const b = splitWords(curr).map(x => x.toLowerCase());
        const max = Math.min(a.length, b.length, 12);
        for (let len = max; len > 0; len--) {
            if (a.slice(-len).join('\u0001') === b.slice(0, len).join('\u0001')) return len;
        }
        return 0;
    }

    function extractNewText(prevFullText, currentText) {
        const prev = cleanText(prevFullText);
        const curr = cleanText(currentText);
        if (!curr) return '';
        if (!prev) return curr;

        const prevLower = prev.toLowerCase();
        const currLower = curr.toLowerCase();
        if (currLower.startsWith(prevLower) && curr.length > prev.length) {
            return cleanText(curr.slice(prev.length));
        }

        const prevWords = splitWords(prev);
        const currWords = splitWords(curr);
        const overlap = suffixPrefixWordOverlap(prev, curr);
        if (overlap > 0 && overlap < currWords.length) {
            return cleanText(joinTokens(currWords.slice(overlap), curr));
        }

        // Character fallback for CJK or non-space captions.
        const max = Math.min(prev.length, curr.length, 80);
        for (let len = max; len > 0; len--) {
            if (prev.slice(-len).toLowerCase() === curr.slice(0, len).toLowerCase()) {
                return cleanText(curr.slice(len));
            }
        }
        return curr;
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

        for (let i = 0; i < events.length - 1; i++) {
            if (events[i].endMs > events[i + 1].startMs) {
                events[i].endMs = Math.max(events[i].startMs + 180, events[i + 1].startMs);
            }
        }
        return events;
    }

    function isRollingCaptionTrack(events) {
        if (!events || events.length < 8) return false;
        let comparable = 0;
        let rolling = 0;
        for (let i = 1; i < events.length; i++) {
            const prev = cleanText(events[i - 1].text);
            const curr = cleanText(events[i].text);
            if (!prev || !curr) continue;
            comparable++;
            const p = prev.toLowerCase();
            const c = curr.toLowerCase();
            if ((c.startsWith(p) && curr.length > prev.length) || suffixPrefixWordOverlap(prev, curr) >= 2) {
                rolling++;
            }
        }
        return comparable >= 6 && rolling / comparable >= 0.32;
    }

    function eventsToAtoms(events, options = {}) {
        const rolling = options.forceRolling != null ? options.forceRolling : isRollingCaptionTrack(events);
        const atoms = [];
        let prevFullText = '';

        for (const ev of events) {
            let newText = rolling ? extractNewText(prevFullText, ev.text) : ev.text;
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

    function dedupeJoinedText(parts) {
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
        return hasCJK(out.join('')) ? out.join('') : out.join(' ');
    }

    function alignNativeTranslations(displayCues, transJson) {
        const translatedEvents = parseTimedTextEvents(transJson);
        if (!translatedEvents.length) return displayCues;
        const translatedAtoms = eventsToAtoms(translatedEvents);

        for (const cue of displayCues) {
            const parts = [];
            for (const t of translatedAtoms) {
                const overlap = Math.min(cue.endMs, t.endMs) - Math.max(cue.startMs, t.startMs);
                if (overlap <= 0) continue;
                const tDur = Math.max(1, t.endMs - t.startMs);
                const cueDur = Math.max(1, cue.endMs - cue.startMs);
                if (overlap / Math.min(tDur, cueDur) >= DISPLAY_RULES.nativeOverlapRatio) {
                    parts.push(t.text);
                }
            }
            const joined = dedupeJoinedText(parts);
            cue.translation = joined || null;
        }
        return displayCues;
    }

    function buildTranslationBlocks(cues) {
        const blocks = [];
        let current = [];

        const flush = () => {
            if (!current.length) return;
            const blockIndex = blocks.length;
            const blockId = `block_${blockIndex}_${Math.round(current[0].startMs)}_${Math.round(current[current.length - 1].endMs)}`;
            const context = current.map(c => c.text).join(' ');
            current.forEach((cue, idx) => {
                cue.translateContext = context;
                cue.translateBlockId = blockId;
                cue.translateBlockIndex = blockIndex;
                cue.translateSegmentIndex = idx;
            });
            blocks.push({ id: blockId, index: blockIndex, cues: current.slice(), text: context });
            current = [];
        };

        for (const cue of cues) {
            if (current.length) {
                const prev = current[current.length - 1];
                const nextBlockText = current.map(c => c.text).join(' ') + ' ' + cue.text;
                const gap = cue.startMs - prev.endMs;
                const shouldSplit =
                    gap > 700 ||
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

    function blockFullyTranslated(block) {
        return !!block && block.cues.every(c => c.translation && c.translation !== '__pending__');
    }

    function findBlockById(manager, blockId) {
        return (manager.translationBlocks || []).find(b => b.id === blockId || b.blockId === blockId);
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
        const atoms = eventsToAtoms(events);
        let displayCues = buildDisplayCues(atoms);
        if (transJson) displayCues = alignNativeTranslations(displayCues, transJson);
        this.translationBlocks = buildTranslationBlocks(displayCues);
        console.log(`[YT Bilingual Optimizer] ${events.length} raw events → ${displayCues.length} display cues → ${this.translationBlocks.length} translation blocks.`);
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
            for (let i = 0; i < events.length - 1; i++) {
                if (events[i].endMs > events[i + 1].startMs) {
                    events[i].endMs = Math.max(events[i].startMs + 180, events[i + 1].startMs);
                }
            }
            const cues = buildDisplayCues(eventsToAtoms(events, { forceRolling: false }));
            this.translationBlocks = buildTranslationBlocks(cues);
            console.log(`[YT Bilingual Optimizer] XML ${events.length} raw events → ${cues.length} display cues → ${this.translationBlocks.length} translation blocks.`);
            return cues;
        } catch (err) {
            console.warn('[YT Bilingual Optimizer] XML parse failed:', err);
            return [];
        }
    };

    M.collectTranslationBlocks = function optimizedCollectTranslationBlocks(entries) {
        return buildTranslationBlocks(entries || []);
    };

    M.loadTimedText = async function optimizedLoadTimedText(rawText, url) {
        if (!originalLoadTimedText) return;
        let nextRawText = rawText;
        let nextUrl = url;

        try {
            const requestMeta = this.extractTimedTextMeta ? this.extractTimedTextMeta(url) : {};
            // In AI mode YouTube may fire only an auto-translated track. Fetch the original
            // instead of ignoring it, otherwise the custom timeline can go stale or empty.
            if (this.settings?.autoTranslate && this.settings?.useAITranslation && requestMeta?.tlang && url) {
                const parsedUrl = new URL(url.startsWith('/') ? window.location.origin + url : url);
                parsedUrl.searchParams.delete('tlang');
                const res = await fetch(parsedUrl.toString());
                if (res.ok) {
                    nextRawText = await res.text();
                    nextUrl = parsedUrl.toString();
                    this.logDebug?.('timedtext-ai-fetched-original-track', {
                        lang: requestMeta.lang || '',
                        ignoredTlang: requestMeta.tlang || ''
                    });
                }
            }
        } catch (err) {
            console.warn('[YT Bilingual Optimizer] Failed to fetch original timedtext track:', err);
        }

        return originalLoadTimedText(nextRawText, nextUrl);
    };

    M._setupCaptions = function optimizedSetupCaptions(entries, requestMeta = null) {
        this.currentCaptionIndex = -1;
        this.lastRenderedId = '';
        this.lastRenderedSignature = '';
        this.priorityTimerId && clearTimeout(this.priorityTimerId);
        this.priorityTimerId = null;
        if (typeof SubtitlePanel !== 'undefined' && SubtitlePanel.clear) {
            try { SubtitlePanel.clear(); } catch { /* ignore */ }
        }
        return originalSetupCaptions ? originalSetupCaptions(entries, requestMeta) : undefined;
    };

    M.findCurrentCaptionIndex = function optimizedFindCurrentCaptionIndex(ms) {
        const cues = this.captions || [];
        if (!cues.length) return -1;

        let i = Number.isInteger(this.currentCaptionIndex) ? this.currentCaptionIndex : 0;
        if (i >= 0 && i < cues.length && ms >= cues[i].startMs && ms < cues[i].endMs) return i;

        if (i >= 0 && i < cues.length) {
            while (i + 1 < cues.length && ms >= cues[i].endMs) i++;
            while (i > 0 && ms < cues[i].startMs) i--;
            if (ms >= cues[i].startMs && ms < cues[i].endMs) {
                this.currentCaptionIndex = i;
                return i;
            }
        }

        let lo = 0;
        let hi = cues.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const cue = cues[mid];
            if (ms < cue.startMs) hi = mid - 1;
            else if (ms >= cue.endMs) lo = mid + 1;
            else {
                this.currentCaptionIndex = mid;
                return mid;
            }
        }
        return -1;
    };

    M.attachTimeupdateListener = function optimizedAttachTimeupdateListener() {
        const attach = () => {
            const video = document.querySelector('video');
            if (!video) { setTimeout(attach, 500); return; }

            if (this.rafId) cancelAnimationFrame(this.rafId);
            if (this._ybSeekHandler) video.removeEventListener('seeking', this._ybSeekHandler);
            this._ybSeekHandler = () => {
                this.currentCaptionIndex = -1;
                this.schedulePriorityPreTranslation?.(this.translationAbortKey);
            };
            video.addEventListener('seeking', this._ybSeekHandler);

            const loop = () => {
                if (!this.subtitleContainer) return;
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
            if (this.lastRenderedSignature !== '') {
                this.lastRenderedSignature = '';
                this.lastRenderedText = '';
                if (this.subtitleContainer) this.subtitleContainer.innerHTML = '';
                if (typeof SubtitlePanel !== 'undefined') SubtitlePanel.setActive?.(-1);
            }
            return;
        }

        const entry = this.captions[index];
        const translation = entry.translation === '__pending__' ? null : entry.translation;
        const needsTranslation = !!(this.settings?.autoTranslate && this.settings?.useAITranslation && entry.translation == null);
        const loading = needsTranslation || entry.translation === '__pending__';
        const signature = `${entry.id || entry.startMs}:${entry.text}:${translation || ''}:${loading}`;

        if (signature !== this.lastRenderedSignature) {
            this.lastRenderedSignature = signature;
            this.lastRenderedText = entry.text;
            this.renderSubtitle(entry.text, translation, loading);

            if (typeof SubtitlePanel !== 'undefined') {
                SubtitlePanel.addSubtitle?.(entry.text, translation || '', entry.startMs / 1000, index);
                SubtitlePanel.updateSubtitleTranslation?.(index, translation || '');
                SubtitlePanel.setActive?.(index);
            }
        }

        if (needsTranslation && entry.translateBlockId) {
            this.markBlockPending?.(entry.translateBlockId);
            this._translateBlock(entry.translateBlockId).then(() => {
                const currentIndex = this.findCurrentCaptionIndex((document.querySelector('video')?.currentTime || 0) * 1000);
                if (currentIndex >= 0 && this.captions[currentIndex]?.translateBlockId === entry.translateBlockId) {
                    this.lastRenderedSignature = '';
                    this.onTimeUpdate(document.querySelector('video')?.currentTime || currentTimeSec);
                }
            }).catch(err => {
                console.warn('[YT Bilingual Optimizer] Current block translation failed:', err);
                this.clearBlockPending?.(entry.translateBlockId, '');
            });
        }

        this.schedulePriorityPreTranslation?.(this.translationAbortKey);
    };

    M.schedulePriorityPreTranslation = function schedulePriorityPreTranslation(runKey = this.translationAbortKey) {
        if (!(this.settings?.autoTranslate && this.settings?.useAITranslation)) return;
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
        const currentBlockIndex = currentCueIndex >= 0 ? (this.captions[currentCueIndex]?.translateBlockIndex ?? 0) : 0;

        return blocks
            .filter(block => !blockFullyTranslated(block))
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
        if (runKey !== this.translationAbortKey) return;
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
                        await this._translateBlock(block.id);
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
        if (!block || !block.cues?.length) return {};
        if (blockFullyTranslated(block)) {
            return Object.fromEntries(block.cues.map(c => [c.id, c.translation]));
        }
        if (this.pendingBlockTranslations?.has(blockId)) {
            return this.pendingBlockTranslations.get(blockId);
        }

        const promise = (async () => {
            block.cues.forEach(cue => {
                if (cue.translation == null) cue.translation = '__pending__';
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

            let byCueId = {};
            try {
                if (TranslatorService.translateStructuredBlock) {
                    byCueId = await TranslatorService.translateStructuredBlock(
                        segments,
                        this.settings.targetLanguage,
                        this.settings.nativeLanguage,
                        this.settings,
                        this.contextBuffer || []
                    );
                }
            } catch (err) {
                console.warn('[YT Bilingual Optimizer] Structured translate unavailable, falling back:', err.message || err);
            }

            if (!byCueId || Object.keys(byCueId).length === 0) {
                const numberedSegments = segments.map(s => ({
                    id: s.numericId,
                    text: s.text,
                    prevText: s.prevText,
                    nextText: s.nextText,
                    displayBreakReason: s.displayBreakReason
                }));
                const numbered = await TranslatorService.translateBlock(
                    numberedSegments,
                    this.settings.targetLanguage,
                    this.settings.nativeLanguage,
                    this.settings,
                    this.contextBuffer || []
                );
                byCueId = {};
                segments.forEach(s => {
                    if (numbered?.[s.numericId]) byCueId[s.id] = numbered[s.numericId];
                });
            }

            for (const cue of block.cues) {
                let translation = normalizeTranslationForDisplay(byCueId?.[cue.id] || '');
                if (!translation) {
                    translation = normalizeTranslationForDisplay(await TranslatorService.translate(
                        cue.text,
                        this.settings.targetLanguage,
                        this.settings.nativeLanguage,
                        this.settings,
                        this.contextBuffer || [],
                        'fast'
                    ));
                }
                cue.translation = translation || '';

                const panelIndex = this.captions.indexOf(cue);
                if (typeof SubtitlePanel !== 'undefined' && panelIndex >= 0) {
                    SubtitlePanel.updateSubtitleTranslation?.(panelIndex, cue.translation);
                }

                if (cue.translation) {
                    this.contextBuffer = this.contextBuffer || [];
                    this.contextBuffer.push({ original: cue.text.slice(0, 120), translated: cue.translation.slice(0, 120) });
                    while (this.contextBuffer.length > 8) this.contextBuffer.shift();
                    if (this.settings?.enableLogging && this.logBuffer) {
                        this.logBuffer.set(cue.text, { timeMs: cue.startMs, translated: cue.translation });
                    }
                }
            }

            return Object.fromEntries(block.cues.map(c => [c.id, c.translation]));
        })();

        this.pendingBlockTranslations = this.pendingBlockTranslations || new Map();
        this.pendingBlockTranslations.set(blockId, promise);
        try {
            return await promise;
        } finally {
            this.pendingBlockTranslations.delete(blockId);
        }
    };

    console.log('[YT Bilingual Optimizer] Installed subtitle readability/alignment fixes.');
})();
'''

OPTIMIZER_CSS = r'''

/* === Subtitle Optimizer Patch: readability guardrails === */
.yb-subtitle-container {
  width: min(86vw, 1120px);
  max-width: 92%;
  bottom: clamp(64px, 10vh, 112px);
  max-height: 42%;
}

.yb-subtitle-line {
  max-width: min(82vw, 1040px);
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  text-wrap: balance;
}

.yb-subtitle-original {
  -webkit-line-clamp: 2;
}

.yb-subtitle-translation {
  -webkit-line-clamp: 2;
  max-width: min(80vw, 980px);
}
'''

BACKGROUND_ROUTE = r'''    if (message.action === 'translateStructuredBlock') {
        handleStructuredBlockTranslate(
            message.segments, message.targetLang, message.nativeLang,
            message.settings, message.context || []
        )
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

'''

BACKGROUND_FUNCTIONS = r'''

// ─── Structured Subtitle Block Translation (stable cue-id JSON) ───────────────

function extractFirstJsonObject(raw) {
    const text = String(raw || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    if (start < 0) return '';

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return '';
}

function parseStructuredTranslationJson(raw, segments) {
    const result = {};
    const wanted = new Set((segments || []).map(s => String(s.id)));

    try {
        const jsonText = extractFirstJsonObject(raw);
        const parsed = JSON.parse(jsonText || raw);
        const items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.translations || []);
        for (const item of items) {
            const id = String(item.id ?? item.cue_id ?? item.cueId ?? '');
            const translation = normalizeTranslationText(item.translation ?? item.text ?? item.value ?? '');
            if (wanted.has(id) && translation) result[id] = translation;
        }
    } catch {
        // Regex fallback for models that ignored JSON but preserved ids.
        const text = String(raw || '').replace(/<TRANSLATIONS>|<\/TRANSLATIONS>/gi, '');
        for (const segment of segments || []) {
            const id = String(segment.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?:^|\\n)\\s*\\[?${id}\\]?\\s*[:：\\]-]\\s*(.+?)(?=\\n\\s*\\[?[A-Za-z0-9_:-]+\\]?\\s*[:：\\]-]|$)`, 's');
            const m = text.match(re);
            if (m) {
                const translation = normalizeTranslationText(m[1]);
                if (translation) result[String(segment.id)] = translation;
            }
        }
    }

    for (const segment of segments || []) {
        if (!result[String(segment.id)]) result[String(segment.id)] = '';
    }
    return result;
}

async function handleStructuredBlockTranslate(segments, targetLang, nativeLang, settings, context = []) {
    if (!segments || !segments.length) return {};

    const stableText = segments.map(s => `${s.id}:${s.text}`).join('|');
    const cacheKey = makeCacheKey('sblk', stableText, targetLang, nativeLang);
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const tName = LANG_NAMES[targetLang] || targetLang;
    const nName = LANG_NAMES[nativeLang] || nativeLang;
    const contextBlock = buildRecentContextBlock(context);

    const payload = {
        items: segments.map(s => ({
            id: String(s.id),
            current: s.text,
            prev_source: s.prevText || '',
            next_source: s.nextText || '',
            break_reason: s.displayBreakReason || ''
        }))
    };

    const system = `You are an expert subtitle translator (${tName} to ${nName}).
Return JSON only. No markdown. No explanations.
Schema exactly: {"items":[{"id":"same id from input","translation":"translated subtitle"}]}
Rules:
- Return one item for every input id, preserving the exact id string.
- Translate CURRENT only. PREV_SOURCE and NEXT_SOURCE are context hints only.
- Do not merge, split, summarize, omit concrete details, or add context-only meaning.
- Keep each translation concise and natural for on-screen subtitles.
- If CURRENT is a sentence fragment, keep the translation fragmentary too.`;

    const userMsg = `${contextBlock}\nTranslate this JSON payload:\n${JSON.stringify(payload, null, 2)}`;

    let rawOutput;
    if (settings.aiProvider === 'local') {
        rawOutput = await fetchOllama(`${system}\n\n${userMsg}`, settings, 1400);
    } else {
        rawOutput = await fetchOpenAI(system, userMsg, settings, 1800);
    }

    const result = parseStructuredTranslationJson(rawOutput || '', segments);

    for (const segment of segments) {
        const id = String(segment.id);
        if (!result[id]) {
            result[id] = await handleTranslate(segment.text, targetLang, nativeLang, settings, context, false, 'fast');
        }
    }

    const gotAll = segments.every(s => result[String(s.id)] && result[String(s.id)].trim());
    if (gotAll) await setCache(cacheKey, result);
    return result;
}
'''


def backup(path: Path) -> None:
    if path.exists():
        bak = path.with_suffix(path.suffix + '.bak.subtitlefix')
        if not bak.exists():
            shutil.copy2(path, bak)


def require(path: Path) -> Path:
    if not path.exists():
        raise FileNotFoundError(f'Missing required file: {path}')
    return path


def patch_manifest(root: Path) -> None:
    path = require(root / 'manifest.json')
    backup(path)
    data = json.loads(path.read_text(encoding='utf-8'))
    changed = False
    for script in data.get('content_scripts', []):
        js = script.get('js') or []
        if 'content/subtitle.js' in js and 'content/subtitleOptimizer.js' not in js:
            idx = js.index('content/subtitle.js')
            js.insert(idx + 1, 'content/subtitleOptimizer.js')
            changed = True
    if changed:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def write_optimizer(root: Path) -> None:
    path = root / 'content' / 'subtitleOptimizer.js'
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup(path)
    path.write_text(SUBTITLE_OPTIMIZER_JS, encoding='utf-8')


def patch_css(root: Path) -> None:
    path = require(root / 'content' / 'content.css')
    backup(path)
    text = path.read_text(encoding='utf-8')
    if 'Subtitle Optimizer Patch: readability guardrails' not in text:
        path.write_text(text.rstrip() + OPTIMIZER_CSS + '\n', encoding='utf-8')


def patch_storage(root: Path) -> None:
    path = require(root / 'lib' / 'storage.js')
    backup(path)
    text = path.read_text(encoding='utf-8')
    text = text.replace("aiProvider: 'openai', // 'openai', 'custom', 'local'", "aiProvider: 'local', // 'openai', 'custom', 'local'")
    text = text.replace("localModel: 'llama3',", "localModel: 'qwen2.5:14b',")
    path.write_text(text, encoding='utf-8')


def patch_background(root: Path) -> None:
    path = require(root / 'background' / 'background.js')
    backup(path)
    text = path.read_text(encoding='utf-8')

    if "message.action === 'translateStructuredBlock'" not in text:
        needle = "    if (message.action === 'translateBlock') {\n"
        if needle not in text:
            raise RuntimeError('Could not find translateBlock route in background/background.js')
        text = text.replace(needle, BACKGROUND_ROUTE + needle, 1)

    if 'function handleStructuredBlockTranslate' not in text:
        marker = '// ─── Web Page Paragraph Translation'
        if marker in text:
            text = text.replace(marker, BACKGROUND_FUNCTIONS + '\n' + marker, 1)
        else:
            text += BACKGROUND_FUNCTIONS

    # Keep installed defaults consistent with StorageHelper defaults.
    if 'useAITranslation: true' not in text:
        text = text.replace(
            "                        autoTranslate: true,\n                        showOriginalSubtitle: true,",
            "                        autoTranslate: true,\n                        useAITranslation: true,\n                        enableLogging: true,\n                        webPageTranslation: false,\n                        showOriginalSubtitle: true,",
            1
        )
    text = text.replace("localModel: 'llama3'", "localModel: 'qwen2.5:14b'")
    path.write_text(text, encoding='utf-8')


def main() -> None:
    root = ROOT
    required = [
        root / 'manifest.json',
        root / 'content' / 'subtitle.js',
        root / 'content' / 'content.css',
        root / 'background' / 'background.js',
        root / 'lib' / 'storage.js',
    ]
    missing = [str(p) for p in required if not p.exists()]
    if missing:
        raise SystemExit('Run this script from the YouTubeTranslator repository root. Missing:\n' + '\n'.join(missing))

    write_optimizer(root)
    patch_manifest(root)
    patch_css(root)
    patch_storage(root)
    patch_background(root)

    print('Subtitle fixes applied successfully.')
    print('Backups were created as *.bak.subtitlefix for modified existing files.')
    print('Reload the unpacked Chrome extension and hard-refresh the YouTube tab.')


if __name__ == '__main__':
    main()
