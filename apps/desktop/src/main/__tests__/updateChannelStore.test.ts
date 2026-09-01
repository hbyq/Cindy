import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appGetPath = vi.fn();
const forkPolicy = vi.hoisted(() => ({ betaAvailable: true }));

vi.mock('electron', () => ({
  app: {
    getPath: appGetPath,
  },
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('../forkUpdatePolicy.js', () => ({
  isForkBetaUpdateChannelAvailable: () => forkPolicy.betaAvailable,
}));

let tempDir: string;

async function loadStore() {
  vi.resetModules();
  return import('../updateChannelStore');
}

beforeEach(() => {
  forkPolicy.betaAvailable = true;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-update-channel-'));
  appGetPath.mockImplementation((name: string) => {
    if (name === 'userData') return tempDir;
    return tempDir;
  });
});

describe('fork Beta update policy', () => {
  it('pins every client update consumer to stable and blocks organization defaults', async () => {
    forkPolicy.betaAvailable = false;
    const store = await loadStore();

    expect(store.readUpdateChannelSettings()).toEqual({
      enableBeta: false,
      orgDefaultEnableBeta: false,
    });
    expect(store.isBetaChannelEnabled()).toBe(false);
    expect(store.isEnableBetaUserCustomized()).toBe(true);
    await expect(store.tryEnableUncustomizedBetaAtomic()).resolves.toBe(false);
    await expect(store.writeEnableBeta(true)).rejects.toThrow(
      'fork beta update channel is unavailable',
    );
    expect(fs.existsSync(path.join(tempDir, 'update-channel-settings.json'))).toBe(false);
  });

  it('ignores a Beta choice persisted by an earlier official build', async () => {
    const store = await loadStore();
    await store.writeEnableBeta(true);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(true);

    forkPolicy.betaAvailable = false;
    expect(store.readUpdateChannelSettings()).toMatchObject({ enableBeta: false });
    expect(store.isBetaChannelEnabled()).toBe(false);
    expect(store.isEnableBetaUserCustomized()).toBe(true);
    await expect(store.tryEnableUncustomizedBetaAtomic()).resolves.toBe(false);
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('tryEnableUncustomizedBetaAtomic', () => {
  it('turns beta on via org default without writing a user enableBeta override', async () => {
    const store = await loadStore();

    expect(store.readUpdateChannelSettingsState()).toMatchObject({
      value: { enableBeta: false, orgDefaultEnableBeta: false },
      customizedKeys: [],
    });
    expect(await store.tryEnableUncustomizedBetaAtomic()).toBe(true);
    expect(store.readUpdateChannelSettings()).toEqual({
      enableBeta: true,
      orgDefaultEnableBeta: true,
    });
    expect(store.isEnableBetaUserCustomized()).toBe(false);
    expect(store.readUpdateChannelSettingsState().customizedKeys).toEqual(['orgDefaultEnableBeta']);
  });

  it('does not reopen beta after the user turned it off', async () => {
    const store = await loadStore();
    await store.writeEnableBeta(true);
    await store.writeEnableBeta(false);

    expect(store.readUpdateChannelSettings()).toMatchObject({ enableBeta: false });
    expect(store.isEnableBetaUserCustomized()).toBe(true);
    expect(await store.tryEnableUncustomizedBetaAtomic()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(false);
  });

  it('keeps a never-enabled opt-out as a user choice', async () => {
    const store = await loadStore();
    await store.writeEnableBeta(false);

    expect(store.isEnableBetaUserCustomized()).toBe(true);
    expect(await store.tryEnableUncustomizedBetaAtomic()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(false);
  });

  it('is a no-op when beta is already on', async () => {
    const store = await loadStore();
    await store.writeEnableBeta(true);

    expect(await store.tryEnableUncustomizedBetaAtomic()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(true);
    expect(store.isEnableBetaUserCustomized()).toBe(true);
  });

  it('does not write when the lock-time identity guard rejects', async () => {
    const store = await loadStore();
    expect(await store.tryEnableUncustomizedBetaAtomic(() => false)).toBe(false);
    expect(store.readUpdateChannelSettings()).toEqual({
      enableBeta: false,
      orgDefaultEnableBeta: false,
    });
  });
});

describe('Linux beta channel gate', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('keeps Linux on the release channel even when disk says beta is on', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const store = await loadStore();
    await store.writeEnableBeta(true);

    expect(store.readUpdateChannelSettings().enableBeta).toBe(true);
    expect(store.isBetaChannelEnabled()).toBe(false);
  });
});
