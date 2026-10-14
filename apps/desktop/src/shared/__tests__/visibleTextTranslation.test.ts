import { describe, expect, it } from 'vitest';

import {
  VISIBLE_TEXT_TRANSLATION_MAX_SOURCE_CHARS,
  normalizeVisibleTextTranslationSource,
  shouldTranslateVisibleText,
} from '../visibleTextTranslation';

describe('visible text translation language gate', () => {
  it('normalizes a visible activity into one logical source line', () => {
    expect(normalizeVisibleTextTranslationSource('  Inspecting\n  files  ')).toBe('Inspecting files');
  });

  it('translates non-Chinese natural language but leaves Chinese untouched', () => {
    expect(shouldTranslateVisibleText('Inspecting the current implementation')).toBe(true);
    expect(shouldTranslateVisibleText('現在の実装を確認しています')).toBe(true);
    expect(shouldTranslateVisibleText('현재 구현을 확인하고 있습니다')).toBe(true);
    expect(shouldTranslateVisibleText('正在检查当前实现')).toBe(false);
    expect(shouldTranslateVisibleText('正在檢查目前實作')).toBe(false);
    expect(shouldTranslateVisibleText('正在检查 OpenRouter settings')).toBe(false);
  });

  it('does not spend a request on non-language or standalone technical text', () => {
    for (const source of [
      '',
      '12345',
      '✨ → ✓',
      'https://openrouter.ai/models',
      'C:\\Users\\Tiantexin\\project',
      '/usr/local/bin/codex',
      'google/gemini-3.5-flash-lite',
      '`git status`',
    ]) {
      expect(shouldTranslateVisibleText(source), source).toBe(false);
    }
  });

  it('rejects long visible thinking instead of sending full reasoning for translation', () => {
    expect(shouldTranslateVisibleText('a'.repeat(VISIBLE_TEXT_TRANSLATION_MAX_SOURCE_CHARS + 1))).toBe(false);
  });
});
