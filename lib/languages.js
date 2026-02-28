/**
 * Language definitions and utilities
 */
const LANGUAGES = {
  en: { name: 'English', nativeName: 'English', code: 'en' },
  zh: { name: 'Chinese', nativeName: '中文', code: 'zh' },
  ja: { name: 'Japanese', nativeName: '日本語', code: 'ja' },
  ko: { name: 'Korean', nativeName: '한국어', code: 'ko' },
  es: { name: 'Spanish', nativeName: 'Español', code: 'es' },
  fr: { name: 'French', nativeName: 'Français', code: 'fr' },
  de: { name: 'German', nativeName: 'Deutsch', code: 'de' },
  pt: { name: 'Portuguese', nativeName: 'Português', code: 'pt' },
  ru: { name: 'Russian', nativeName: 'Русский', code: 'ru' },
  ar: { name: 'Arabic', nativeName: 'العربية', code: 'ar' },
  hi: { name: 'Hindi', nativeName: 'हिन्दी', code: 'hi' },
  it: { name: 'Italian', nativeName: 'Italiano', code: 'it' },
  th: { name: 'Thai', nativeName: 'ไทย', code: 'th' },
  vi: { name: 'Vietnamese', nativeName: 'Tiếng Việt', code: 'vi' },
  tr: { name: 'Turkish', nativeName: 'Türkçe', code: 'tr' },
  pl: { name: 'Polish', nativeName: 'Polski', code: 'pl' },
  nl: { name: 'Dutch', nativeName: 'Nederlands', code: 'nl' },
  sv: { name: 'Swedish', nativeName: 'Svenska', code: 'sv' },
  uk: { name: 'Ukrainian', nativeName: 'Українська', code: 'uk' },
  id: { name: 'Indonesian', nativeName: 'Bahasa Indonesia', code: 'id' }
};

const PROFICIENCY_LEVELS = {
  beginner: { label: 'Beginner (A1-A2)', value: 'beginner', description: 'Most words are new to you' },
  intermediate: { label: 'Intermediate (B1-B2)', value: 'intermediate', description: 'You know common words' },
  advanced: { label: 'Advanced (C1-C2)', value: 'advanced', description: 'You know most words' }
};

/**
 * Check if a character is CJK (Chinese, Japanese, Korean)
 */
function isCJK(char) {
  const code = char.charCodeAt(0);
  return (code >= 0x4E00 && code <= 0x9FFF) || // CJK Unified Ideographs
    (code >= 0x3040 && code <= 0x309F) || // Hiragana
    (code >= 0x30A0 && code <= 0x30FF) || // Katakana
    (code >= 0xAC00 && code <= 0xD7AF) || // Hangul
    (code >= 0x3400 && code <= 0x4DBF) || // CJK Extension A
    (code >= 0xF900 && code <= 0xFAFF);   // CJK Compatibility
}

/**
 * Tokenize text into words based on language
 */
function tokenizeText(text, langCode) {
  if (!text) return [];
  
  // For CJK languages, split by character
  if (['zh', 'ja'].includes(langCode)) {
    return text.split('').filter(c => c.trim());
  }
  
  // For other languages, split by word boundaries
  const words = text.match(/[\w\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]+|[^\s\w]+/g);
  return words || [];
}

/**
 * Check if a token is a word (not punctuation)
 */
function isWord(token) {
  return /[\w\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(token);
}
