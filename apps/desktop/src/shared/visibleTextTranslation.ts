/**
 * Wire contract for Cindy's optional user-visible text translation layer.
 *
 * The source text always remains authoritative. Main returns only a translated
 * line; Renderer is responsible for displaying `source` first and translation
 * second so a model can never rewrite or hide the original.
 */

export const VISIBLE_TEXT_TRANSLATION_INVOKE = 'visible-text-translation:translate';

export const VISIBLE_TEXT_TRANSLATION_MAX_SOURCE_CHARS = 1_000;

export type VisibleTextTranslationResult =
  | { status: 'translated'; translation: string }
  | { status: 'skipped' | 'unavailable'; translation: null };

const HAN_RE = /\p{Script=Han}/u;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const LETTER_RE = /\p{L}/u;
const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;
const WINDOWS_PATH_RE = /^[a-z]:[\\/]/i;
const POSIX_PATH_RE = /^(?:~\/|\.{1,2}\/|\/)(?!\/)/;
const CODE_SPAN_RE = /^`[^`]+`$/;
const TECHNICAL_IDENTIFIER_RE = /^[\p{L}\p{N}@._:/\\+-]+$/u;

/** Collapse a short UI activity into one logical source line. */
export function normalizeVisibleTextTranslationSource(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Cheap local language gate. Han text without Japanese kana is treated as
 * Chinese and stays untouched. Kana/Hangul remain eligible even when the text
 * also contains Han characters. Symbols, paths made only from punctuation,
 * numbers and emoji are not useful translation requests.
 */
export function shouldTranslateVisibleText(value: unknown): boolean {
  const source = normalizeVisibleTextTranslationSource(value);
  if (!source || source.length > VISIBLE_TEXT_TRANSLATION_MAX_SOURCE_CHARS) return false;
  if (!LETTER_RE.test(source)) return false;
  if (
    URL_RE.test(source)
    || WINDOWS_PATH_RE.test(source)
    || POSIX_PATH_RE.test(source)
    || CODE_SPAN_RE.test(source)
    || (TECHNICAL_IDENTIFIER_RE.test(source) && /[._:/\\@+-]/.test(source))
  ) return false;
  if (KANA_RE.test(source) || HANGUL_RE.test(source)) return true;
  return !HAN_RE.test(source);
}
