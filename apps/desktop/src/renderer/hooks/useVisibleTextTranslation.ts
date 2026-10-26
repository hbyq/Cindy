import { useEffect, useMemo, useState } from 'react';

import {
  VISIBLE_TEXT_TRANSLATION_MAX_SOURCE_CHARS,
  normalizeVisibleTextTranslationSource,
  shouldTranslateVisibleText,
} from '../../shared/visibleTextTranslation';

const REQUEST_DEBOUNCE_MS = 300;
const FAILURE_RETRY_MS = 30_500;

/**
 * Translate a short, already-visible work summary without delaying its source
 * text. Main owns routing, credentials, de-duplication and failure backoff.
 */
export function useVisibleTextTranslation(rawSource: string, enabled = true): {
  source: string;
  translation: string | null;
} {
  const source = useMemo(
    () => {
      // Streaming reasoning can grow on every delta. Do not repeatedly scan
      // or allocate from it while translation is disabled, and mirror Main's
      // raw IPC bound before normalization when the block finally settles.
      if (!enabled || rawSource.length > VISIBLE_TEXT_TRANSLATION_MAX_SOURCE_CHARS) return '';
      return normalizeVisibleTextTranslationSource(rawSource);
    },
    [enabled, rawSource],
  );
  const eligible = enabled && shouldTranslateVisibleText(source);
  const [resolved, setResolved] = useState<{
    source: string;
    translation: string;
  } | null>(null);
  const translation = eligible && resolved?.source === source
    ? resolved.translation
    : null;

  useEffect(() => {
    if (!eligible) return;
    const api = window.electronAPI?.visibleTextTranslation;
    if (!api) return;

    let cancelled = false;
    let retryTimer: number | null = null;
    const request = (allowRetry: boolean): void => {
      void api.translate(source)
        .then((result) => {
          if (!cancelled && result.status === 'translated') {
            setResolved({ source, translation: result.translation });
          } else if (!cancelled && allowRetry && result.status === 'unavailable') {
            retryTimer = window.setTimeout(() => request(false), FAILURE_RETRY_MS);
          }
        })
        .catch(() => {
          // Main deliberately treats translation as best effort. Preserve the
          // same original-only fallback if IPC disappears during app shutdown.
        });
    };
    const timer = window.setTimeout(() => request(true), REQUEST_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [eligible, source]);

  return { source, translation };
}
