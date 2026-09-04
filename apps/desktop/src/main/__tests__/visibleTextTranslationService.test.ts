import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  ownerScope: 'cloud:owner-a:1',
  boundaryPending: false,
  ipcHandle: vi.fn(),
  assertTrustedAppRendererEvent: vi.fn(),
  settings: {
    enabled: true,
    providerId: 'openrouter',
    agentKind: 'codex' as const,
    model: 'google/gemini-3.5-flash-lite',
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: harness.ipcHandle },
}));

vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => harness.ownerScope,
  isAppSessionBoundaryPending: () => harness.boundaryPending,
  ownerScopedUserDataPath: (name: string) => `/tmp/test-owner/${name}`,
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../visible-text-translation-settings-store.js', () => ({
  readVisibleTextTranslationSettings: () => ({ ...harness.settings }),
}));

vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: harness.assertTrustedAppRendererEvent,
}));

vi.mock('../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: vi.fn(),
}));

import {
  __testing,
  registerVisibleTextTranslationIpc,
  translateVisibleText,
} from '../visibleTextTranslationService';
import {
  VISIBLE_TEXT_TRANSLATION_INVOKE,
  VISIBLE_TEXT_TRANSLATION_MAX_SOURCE_CHARS,
} from '../../shared/visibleTextTranslation';

beforeEach(() => {
  harness.ownerScope = 'cloud:owner-a:1';
  harness.boundaryPending = false;
  harness.settings.enabled = true;
  harness.settings.providerId = 'openrouter';
  harness.settings.model = 'google/gemini-3.5-flash-lite';
  harness.ipcHandle.mockReset();
  harness.assertTrustedAppRendererEvent.mockReset();
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
      reasoningEffort: 'minimal',
      disableReasoning: true,
      beforeDispatch: expect.any(Function),
    });
    expect(requestText.mock.calls[0]?.[1]).toContain('<SOURCE>\nInspecting the current implementation\n</SOURCE>');
  });

  it('revalidates owner, settings and exact route immediately before HTTP dispatch', async () => {
    const requestText = vi.fn(async (
      _maker: unknown,
      _prompt: string,
      options: Record<string, unknown>,
    ) => {
      const beforeDispatch = options.beforeDispatch as (route: {
        providerId: string;
        agentKind: 'codex' | 'claude-code';
        model: string;
      }) => Promise<boolean>;
      const route = {
        providerId: 'openrouter',
        agentKind: 'codex' as const,
        model: 'google/gemini-3.5-flash-lite',
      };

      await expect(beforeDispatch(route)).resolves.toBe(true);
      await expect(beforeDispatch({ ...route, providerId: 'other' })).resolves.toBe(false);
      await expect(beforeDispatch({ ...route, agentKind: 'claude-code' })).resolves.toBe(false);
      await expect(beforeDispatch({ ...route, model: 'other/model' })).resolves.toBe(false);

      harness.ownerScope = 'cloud:owner-b:2';
      await expect(beforeDispatch(route)).resolves.toBe(false);
      harness.ownerScope = 'cloud:owner-a:1';
      harness.boundaryPending = true;
      await expect(beforeDispatch(route)).resolves.toBe(false);
      harness.boundaryPending = false;
      harness.settings.model = 'other/model';
      await expect(beforeDispatch(route)).resolves.toBe(false);
      harness.settings.model = route.model;

      return {
        ok: true as const,
        text: '正在检查派发边界',
        providerId: route.providerId,
        model: route.model,
        transport: 'codex-responses' as const,
      };
    });

    await expect(translateVisibleText('Inspecting the dispatch boundary', {
      getMaker: () => ({}) as never,
      requestText: requestText as never,
    })).resolves.toEqual({
      status: 'translated',
      translation: '正在检查派发边界',
    });
  });

  it('does not confuse distinct routes whose old delimiter keys would collide', async () => {
    harness.settings.providerId = 'a\u0000codex';
    harness.settings.model = 'x';
    const requestText = vi.fn(async (
      _maker: unknown,
      _prompt: string,
      options: Record<string, unknown>,
    ) => {
      const beforeDispatch = options.beforeDispatch as (route: {
        providerId: string;
        agentKind: 'codex';
        model: string;
      }) => Promise<boolean>;
      const originalRoute = {
        providerId: 'a\u0000codex',
        agentKind: 'codex' as const,
        model: 'x',
      };

      harness.settings.providerId = 'a';
      harness.settings.model = 'codex\u0000x';
      await expect(beforeDispatch(originalRoute)).resolves.toBe(false);
      return {
        ok: true as const,
        text: '不应显示此译文',
        providerId: originalRoute.providerId,
        model: originalRoute.model,
        transport: 'codex-responses' as const,
      };
    });

    await expect(translateVisibleText('Inspecting route identity', {
      getMaker: () => ({}) as never,
      requestText: requestText as never,
    })).resolves.toEqual({ status: 'unavailable', translation: null });
  });

  it('rejects a successful response attributed to a different provider or model', async () => {
    const requestText = vi.fn(async () => ({
      ok: true as const,
      text: '不应显示此译文',
      providerId: 'other-provider',
      model: harness.settings.model,
      transport: 'codex-responses' as const,
    }));

    await expect(translateVisibleText('Inspecting returned route identity', {
      getMaker: () => ({}) as never,
      requestText: requestText as never,
    })).resolves.toEqual({ status: 'unavailable', translation: null });
  });

  it('rejects control characters in persisted provider and model identifiers', async () => {
    const actualStore = await vi.importActual<
      typeof import('../visible-text-translation-settings-store.js')
    >('../visible-text-translation-settings-store.js');
    expect(actualStore.__testing.normalize({
      enabled: true,
      providerId: 'open\u0000router',
      agentKind: 'codex',
      model: 'model\nname',
    })).toEqual({
      enabled: true,
      providerId: actualStore.__testing.DEFAULTS.providerId,
      agentKind: 'codex',
      model: actualStore.__testing.DEFAULTS.model,
    });
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

  it('guards IPC before payload handling and rejects invalid raw sizes without model work', async () => {
    const getMaker = vi.fn(() => ({}) as never);
    const requestText = vi.fn();
    registerVisibleTextTranslationIpc({ getMaker, requestText: requestText as never });

    expect(harness.ipcHandle).toHaveBeenCalledTimes(1);
    expect(harness.ipcHandle).toHaveBeenCalledWith(
      VISIBLE_TEXT_TRANSLATION_INVOKE,
      expect.any(Function),
    );
    const handler = harness.ipcHandle.mock.calls[0]?.[1] as (
      event: unknown,
      source: unknown,
    ) => Promise<unknown>;
    const event = { sender: { id: 7 } };

    harness.assertTrustedAppRendererEvent.mockImplementationOnce(() => {
      throw new Error('[PERMISSION_DENIED] untrusted renderer');
    });
    expect(() => handler(event, 'Inspecting the implementation')).toThrow('PERMISSION_DENIED');

    const oversizedWhitespace = `Inspecting${' '.repeat(
      VISIBLE_TEXT_TRANSLATION_MAX_SOURCE_CHARS + 1,
    )}the implementation`;
    await expect(handler(event, oversizedWhitespace)).resolves.toEqual({
      status: 'skipped',
      translation: null,
    });
    await expect(handler(event, { source: 'Inspecting the implementation' })).resolves.toEqual({
      status: 'skipped',
      translation: null,
    });

    expect(harness.assertTrustedAppRendererEvent).toHaveBeenCalledTimes(3);
    expect(harness.assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(1, event);
    expect(getMaker).not.toHaveBeenCalled();
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
