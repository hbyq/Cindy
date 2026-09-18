import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  isDev: vi.fn(() => false),
  netRequest: vi.fn(),
  platformKey: 'win32-x64',
}));

vi.mock('electron', () => ({ net: { request: mocks.netRequest } }));
vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));
vi.mock('../manifestService', () => ({
  getPlatformKey: () => mocks.platformKey,
  isDev: mocks.isDev,
}));

import {
  CUSTOM_UPDATE_FEED_ID,
  compareCustomUpdateVersions,
  fetchCustomUpdateManifest,
  getCustomUpdateBaseUrl,
  getCustomUpdateManifestUrl,
  getCustomUpdatePlatformKey,
  isCustomUpdatePlatformSupported,
  parseCustomUpdateManifest,
} from '../customUpdateFeed';
import { isForkBetaUpdateChannelAvailable } from '../forkUpdatePolicy';

const SHA = 'a'.repeat(64);

function mockNetResponse(statusCode: number, chunks: Buffer[] = []) {
  const request = new EventEmitter() as EventEmitter & {
    abort: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  const response = new EventEmitter() as EventEmitter & { statusCode: number };
  response.statusCode = statusCode;
  request.abort = vi.fn();
  request.end = vi.fn(() => {
    request.emit('response', response);
    for (const chunk of chunks) response.emit('data', chunk);
    response.emit('end');
  });
  mocks.netRequest.mockReturnValue(request);
  return request;
}

describe('customUpdateFeed', () => {
  beforeEach(() => {
    mocks.platformKey = 'win32-x64';
    mocks.isDev.mockReset();
    mocks.isDev.mockReturnValue(false);
    mocks.netRequest.mockReset();
  });

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
    expect(CUSTOM_UPDATE_FEED_ID).toBe('hbyq-cindy-custom-stable-v1');
    expect(getCustomUpdateBaseUrl()).toBe(
      'https://github.com/hbyq/Cindy/releases/download/cindy-custom-stable',
    );
    expect(getCustomUpdateManifestUrl('win32-x64', 123)).toBe(
      'https://raw.githubusercontent.com/hbyq/Cindy/custom-update-channel/manifest-win32-x64.json?t=123',
    );
  });

  it('supports only the artifact platform published by this fork', () => {
    expect(getCustomUpdatePlatformKey()).toBe('win32-x64');
    expect(isCustomUpdatePlatformSupported('win32-x64')).toBe(true);
    expect(isCustomUpdatePlatformSupported('win32-arm64')).toBe(false);
    expect(isCustomUpdatePlatformSupported('darwin-arm64')).toBe(false);
    expect(isCustomUpdatePlatformSupported('linux-x64')).toBe(false);
  });

  it('keeps the fork beta channel disabled until it has a separate feed', () => {
    expect(isForkBetaUpdateChannelAvailable()).toBe(false);
  });

  it('does not contact the fork update channel in development', async () => {
    mocks.isDev.mockReturnValueOnce(true);

    await expect(fetchCustomUpdateManifest()).resolves.toBeNull();

    expect(mocks.netRequest).not.toHaveBeenCalled();
  });

  it('fails closed without contacting another platform or the official update feed', async () => {
    mocks.platformKey = 'linux-x64';

    await expect(fetchCustomUpdateManifest()).resolves.toBeNull();

    expect(mocks.netRequest).not.toHaveBeenCalled();
  });

  it('decodes a valid manifest when a UTF-8 character is split across chunks', async () => {
    const body = Buffer.from(JSON.stringify({
      app: {
        version: '0.1.6001',
        releaseNotes: '基于官方 v0.1.60',
        hotfix: { file: 'cindy-0.1.6001-hotfix.zip', sha256: SHA, size: 42 },
      },
    }));
    const chineseOffset = body.indexOf(Buffer.from('基'));
    expect(chineseOffset).toBeGreaterThan(0);
    const request = mockNetResponse(200, [
      body.subarray(0, chineseOffset + 1),
      body.subarray(chineseOffset + 1),
    ]);

    await expect(fetchCustomUpdateManifest()).resolves.toMatchObject({
      app: { version: '0.1.6001', releaseNotes: '基于官方 v0.1.60' },
    });
    expect(request.abort).not.toHaveBeenCalled();
  });

  it('fails closed on a non-success response', async () => {
    const request = mockNetResponse(404);

    await expect(fetchCustomUpdateManifest()).resolves.toBeNull();

    expect(request.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts a manifest response that exceeds the byte limit', async () => {
    const request = mockNetResponse(200, [Buffer.alloc(128 * 1024 + 1, 0x61)]);

    await expect(fetchCustomUpdateManifest()).resolves.toBeNull();

    expect(request.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the request when the caller signal is cancelled', async () => {
    const request = new EventEmitter() as EventEmitter & {
      abort: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    request.abort = vi.fn();
    request.end = vi.fn();
    mocks.netRequest.mockReturnValue(request);
    const controller = new AbortController();

    const result = fetchCustomUpdateManifest(30_000, controller.signal);
    controller.abort();

    await expect(result).resolves.toBeNull();
    expect(request.abort).toHaveBeenCalledTimes(1);
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
