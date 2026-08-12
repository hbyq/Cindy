// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

import { ThinkingCard } from '@/components/chat/ThinkingCard';
import { ThinkingText, tokenizeThinkingText } from '@/components/chat/ThinkingText';
import { __test_internals as expandMemory } from '@/hooks/useExpandedBlockMemory';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});
beforeEach(() => expandMemory.reset());

describe('ThinkingText — limited inline markup', () => {
  it('parses paired strong markers and backtick code without a block Markdown renderer', () => {
    expect(tokenizeThinkingText('**Inspecting files** with `git status`')).toEqual([
      { kind: 'strong', value: 'Inspecting files' },
      { kind: 'text', value: ' with ' },
      { kind: 'code', value: 'git status' },
    ]);

    const { container } = render(
      createElement(ThinkingText, {
        content: '**Inspecting files** with `git status` and [docs](https://example.com)',
      }),
    );
    expect(screen.getByText('Inspecting files').classList.contains('font-medium')).toBe(true);
    expect(screen.getByText('git status').tagName).toBe('CODE');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[docs](https://example.com)');
    expect(container.textContent).not.toContain('**');
  });

  it('keeps unmatched, escaped, glob, and triple-star delimiters literal', () => {
    const literalCases = [
      '**unfinished',
      String.raw`\**escaped**`,
      '**/*.ts',
      '***nested***',
      '2 ** 3',
    ];
    for (const content of literalCases) {
      expect(tokenizeThinkingText(content)).toEqual([{ kind: 'text', value: content }]);
    }
  });

  it('normalizes code-span line breaks but preserves ordinary multi-line text', () => {
    const { container } = render(
      createElement(ThinkingText, {
        content: 'first line\nsecond line with `git\nstatus`',
      }),
    );
    expect(container.textContent).toBe('first line\nsecond line with git status');
  });
});

describe('ThinkingCard — shared thinking presentation', () => {
  it('uses the same marker rendering after the standalone card is expanded', () => {
    const { container } = render(
      createElement(ThinkingCard, {
        blockKey: 'standalone-thinking',
        content: '**Reviewing the implementation**',
        durationMs: 1_000,
      }),
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Reviewing the implementation')).toBeTruthy();
    expect(container.textContent).not.toContain('**');
  });

  it('translates a finalized standalone block only after the user expands it', async () => {
    const translate = vi.fn(async () => ({
      status: 'translated' as const,
      translation: '正在审查实现',
    }));
    (window as unknown as {
      electronAPI: { visibleTextTranslation: { translate: typeof translate } };
    }).electronAPI = { visibleTextTranslation: { translate } };
    const { container } = render(
      createElement(ThinkingCard, {
        blockKey: 'translated-standalone-thinking',
        content: 'Reviewing\nthe implementation',
        durationMs: 1_000,
      }),
    );

    expect(translate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(container.textContent).toContain('Reviewing\nthe implementation');
    await waitFor(() => expect(screen.getByText('正在审查实现')).toBeTruthy());
    expect(container.textContent).toContain('Reviewing\nthe implementation');
    expect(translate).toHaveBeenCalledWith('Reviewing the implementation');
  });
});
