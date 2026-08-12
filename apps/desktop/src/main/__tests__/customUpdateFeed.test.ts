import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isDev: vi.fn(() => false),
  netRequest: vi.fn(),
}));

vi.mock('electron', () => ({ net: { request: mocks.netRequest } }));
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));
vi.mock('../manifestService', () => ({
  getPlatformKey: () => 'win32-x64',
  isDev: mocks.isDev,
}));

import {
  compareCustomUpdateVersions,
  fetchCustomUpdateManifest,
  getCustomUpdateBaseUrl,
  getCustomUpdateManifestUrl,
  parseCustomUpdateManifest,
} from '../customUpdateFeed';

const SHA = 'a'.repeat(64);

describe('customUpdateFeed', () => {
  it.each([
    ['0.1.2801', '0.1.28', 1],
    ['0.1.28', '0.1.2801', -1],
    ['1.0.0', '1.0.0', 0],
    ['01.0.0', '1.0.0', null],
    ['1.0.0-beta', '1.0.0', null],
    [`1.0.${Number.MAX_SAFE_INTEGER}0`, '1.0.0', null],
  ])('compares strict numeric versions: %s vs %s', (left, right, expected) => {
    expect(compareCustomUpdateVersions(left, right)).toBe(expected);
  });

  it('uses an isolated fork channel for app updates', () => {
    expect(getCustomUpdateBaseUrl()).toBe(
      'https://github.com/hbyq/Cindy/releases/download/cindy-custom-stable',
    );
    expect(getCustomUpdateManifestUrl('win32-x64', 123)).toBe(
      'https://raw.githubusercontent.com/hbyq/Cindy/custom-update-channel/manifest-win32-x64.json?t=123',
    );
  });

  it('does not contact the fork update channel in development', async () => {
    mocks.isDev.mockReturnValueOnce(true);

    await expect(fetchCustomUpdateManifest()).resolves.toBeNull();

    expect(mocks.netRequest).not.toHaveBeenCalled();
  });

  it('accepts a strict versioned update manifest', () => {
    expect(
      parseCustomUpdateManifest(
        JSON.stringify({
          app: {
            version: '0.1.2801',
            releaseNotes: '基于官方 v0.1.28',
            requireRelogin: true,
            hotfix: { file: 'cindy-0.1.2801-hotfix.zip', sha256: SHA, size: 42 },
            installer: { file: 'cindy-0.1.2801-Setup.exe', sha256: SHA, size: 84 },
          },
          claudeCode: { file: 'must-not-be-consumed' },
        }),
      ),
    ).toEqual({
      app: {
        version: '0.1.2801',
        releaseNotes: '基于官方 v0.1.28',
        requireRelogin: true,
        hotfix: { file: 'cindy-0.1.2801-hotfix.zip', sha256: SHA, size: 42 },
        installer: { file: 'cindy-0.1.2801-Setup.exe', sha256: SHA, size: 84 },
      },
    });
  });

  it.each([
    { version: '0.1.28-custom', file: 'cindy-hotfix.zip', sha256: SHA, size: 42 },
    { version: '00.1.28', file: 'cindy-hotfix.zip', sha256: SHA, size: 42 },
    { version: '0.1.2801', file: '../cindy-hotfix.zip', sha256: SHA, size: 42 },
    { version: '0.1.2801', file: 'cindy-hotfix.zip', sha256: 'bad', size: 42 },
    { version: '0.1.2801', file: 'cindy-hotfix.zip', sha256: SHA, size: 0 },
  ])('rejects an unsafe hotfix descriptor: %o', ({ version, file, sha256, size }) => {
    expect(
      parseCustomUpdateManifest(
        JSON.stringify({
          app: { version, hotfix: { file, sha256, size } },
        }),
      ),
    ).toBeNull();
  });
});
