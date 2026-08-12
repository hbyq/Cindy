import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  ownerScope: 'cloud:owner-a:1',
  boundaryPending: false,
  settings: {
    enabled: true,
    providerId: 'openrouter',
    agentKind: 'codex' as const,
    model: 'google/gemini-3.5-flash-lite',
  },
}));

vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => harness.ownerScope,
  isAppSessionBoundaryPending: () => harness.boundaryPending,
}));

vi.mock('../visible-text-translation-settings-store.js', () => ({
  readVisibleTextTranslationSettings: () => ({ ...harness.settings }),
}));

vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

vi.mock('../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: vi.fn(),
}));

import {
  __testing,
  translateVisibleText,
} from '../visibleTextTranslationService';

beforeEach(() => {
  harness.ownerScope = 'cloud:owner-a:1';
  harness.boundaryPending = false;
  harness.settings.enabled = true;
  __testing.reset();
});

describe('visible text translation service', () => {
  it('routes English through the configured OpenRouter model and caches the result', async () => {
    const requestText = vi.fn(async (
      ..._args: [unknown, string, Record<string, unknown>]
    ) => {
      void _args;
      return {
        ok: true as const,
        text: '正在检查当前实现',
        providerId: 'openrouter',
        model: harness.settings.model,
        transport: 'codex-responses' as const,
      };
    });
    const deps = { getMaker: () => ({}) as never, requestText: requestText as never };

    await expect(translateVisibleText(' Inspecting\n the current implementation ', deps)).resolves.toEqual({
      status: 'translated',
      translation: '正在检查当前实现',
    });
    await expect(translateVisibleText('Inspecting the current implementation', deps)).resolves.toEqual({
      status: 'translated',
      translation: '正在检查当前实现',
    });

    expect(requestText).toHaveBeenCalledTimes(1);
    expect(requestText.mock.calls[0]?.[2]).toMatchObject({
      providerId: 'openrouter',
      agentKind: 'codex',
      model: 'google/gemini-3.5-flash-lite',
      maxTokens: 256,
      timeoutMs: 6_000,
    });
    expect(requestText.mock.calls[0]?.[1]).toContain('<SOURCE>\nInspecting the current implementation\n</SOURCE>');
  });

  it('skips Chinese and technical-only text without touching the model', async () => {
    const requestText = vi.fn();
    const deps = { getMaker: () => ({}) as never, requestText: requestText as never };

    await expect(translateVisibleText('正在检查当前实现', deps)).resolves.toEqual({
      status: 'skipped',
      translation: null,
    });
    await expect(translateVisibleText('google/gemini-3.5-flash-lite', deps)).resolves.toEqual({
      status: 'skipped',
      translation: null,
    });
    expect(requestText).not.toHaveBeenCalled();
  });

  it('does not surface a late translation after the active owner changes', async () => {
    let resolveRequest!: (value: {
      ok: true;
      text: string;
      providerId: string;
      model: string;
      transport: 'codex-responses';
    }) => void;
    const requestText = vi.fn(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const pending = translateVisibleText('Reviewing the implementation', {
      getMaker: () => ({}) as never,
      requestText: requestText as never,
    });
    await Promise.resolve();
    harness.ownerScope = 'cloud:owner-b:2';
    resolveRequest({
      ok: true,
      text: '正在审查实现',
      providerId: 'openrouter',
      model: harness.settings.model,
      transport: 'codex-responses',
    });

    await expect(pending).resolves.toEqual({ status: 'unavailable', translation: null });
  });

  it('fails closed before dispatch when an owner boundary is already pending', async () => {
    harness.boundaryPending = true;
    const requestText = vi.fn();
    await expect(translateVisibleText('Inspecting the implementation', {
      getMaker: () => ({}) as never,
      requestText: requestText as never,
    })).resolves.toEqual({ status: 'unavailable', translation: null });
    expect(requestText).not.toHaveBeenCalled();
  });

  it('limits provider concurrency while allowing queued translations to continue', async () => {
    type Success = {
      ok: true;
      text: string;
      providerId: string;
      model: string;
      transport: 'codex-responses';
    };
    const resolvers: Array<(value: Success) => void> = [];
    const requestText = vi.fn(() => new Promise<Success>((resolve) => resolvers.push(resolve)));
    const deps = { getMaker: () => ({}) as never, requestText: requestText as never };
    const requests = [
      translateVisibleText('Inspecting alpha implementation', deps),
      translateVisibleText('Inspecting beta implementation', deps),
      translateVisibleText('Inspecting gamma implementation', deps),
    ];
    await Promise.resolve();
    await Promise.resolve();
    expect(requestText).toHaveBeenCalledTimes(2);

    resolvers[0]?.({
      ok: true,
      text: '正在检查甲实现',
      providerId: 'openrouter',
      model: harness.settings.model,
      transport: 'codex-responses',
    });
    await requests[0];
    await Promise.resolve();
    expect(requestText).toHaveBeenCalledTimes(3);
    resolvers[1]?.({
      ok: true,
      text: '正在检查乙实现',
      providerId: 'openrouter',
      model: harness.settings.model,
      transport: 'codex-responses',
    });
    resolvers[2]?.({
      ok: true,
      text: '正在检查丙实现',
      providerId: 'openrouter',
      model: harness.settings.model,
      transport: 'codex-responses',
    });
    await Promise.all(requests);
  });

  it('drops queued work when the global translation setting changes before dispatch', async () => {
    type Success = {
      ok: true;
      text: string;
      providerId: string;
      model: string;
      transport: 'codex-responses';
    };
    const resolvers: Array<(value: Success) => void> = [];
    const requestText = vi.fn(() => new Promise<Success>((resolve) => resolvers.push(resolve)));
    const deps = { getMaker: () => ({}) as never, requestText: requestText as never };
    const requests = [
      translateVisibleText('Reviewing queued alpha work', deps),
      translateVisibleText('Reviewing queued beta work', deps),
      translateVisibleText('Reviewing queued gamma work', deps),
    ];
    await Promise.resolve();
    await Promise.resolve();
    expect(requestText).toHaveBeenCalledTimes(2);

    harness.settings.enabled = false;
    resolvers[0]?.({
      ok: true,
      text: '正在审查甲任务',
      providerId: 'openrouter',
      model: harness.settings.model,
      transport: 'codex-responses',
    });
    await requests[0];
    await expect(requests[2]).resolves.toEqual({ status: 'unavailable', translation: null });
    expect(requestText).toHaveBeenCalledTimes(2);
    resolvers[1]?.({
      ok: true,
      text: '正在审查乙任务',
      providerId: 'openrouter',
      model: harness.settings.model,
      transport: 'codex-responses',
    });
    await Promise.all(requests);
  });

  it('normalizes labels, JSON wrappers and newlines into one translation line', () => {
    expect(__testing.normalizeTranslation('译文：正在\n检查', 'Inspecting')).toBe('正在 检查');
    expect(
      __testing.normalizeTranslation('{"translation":"正在检查"}', 'Inspecting'),
    ).toBe('正在检查');
    expect(__testing.normalizeTranslation('I cannot translate that.', 'Inspecting')).toBeNull();
  });
});
