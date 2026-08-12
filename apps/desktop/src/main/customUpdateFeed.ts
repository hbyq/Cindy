/**
 * Fork-only desktop update feed.
 *
 * The official endpoint manifest remains the source for every hosted Cindy
 * service and for agent binaries. Only the desktop app update manifest is
 * read from the hbyq/Cindy fork, so an official release cannot overwrite the
 * visible-text translation customization with an unmodified hotfix.
 */

import { net } from 'electron';

import { createLogger } from './logger';
import { getPlatformKey, isDev } from './manifestService';
import type { Manifest, PlatformAsset } from './manifestService';

const log = createLogger('customUpdateFeed');

const CUSTOM_UPDATE_CHANNEL_BASE_URL =
  'https://raw.githubusercontent.com/hbyq/Cindy/custom-update-channel';
const CUSTOM_UPDATE_RELEASE_BASE_URL =
  'https://github.com/hbyq/Cindy/releases/download/cindy-custom-stable';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MANIFEST_BYTES = 128 * 1024;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const SAFE_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function getCustomUpdateBaseUrl(): string {
  return CUSTOM_UPDATE_RELEASE_BASE_URL;
}

function parseStrictVersion(version: string): readonly [number, number, number] | null {
  const match = VERSION_RE.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as unknown as readonly [number, number, number];
}

/** Compare canonical three-part numeric versions, or fail closed on invalid input. */
export function compareCustomUpdateVersions(left: string, right: string): -1 | 0 | 1 | null {
  const leftParts = parseStrictVersion(left);
  const rightParts = parseStrictVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function getCustomUpdateManifestUrl(
  platformKey = getPlatformKey(),
  cacheBust = Date.now(),
): string {
  if (!/^[a-z0-9]+-[a-z0-9]+$/i.test(platformKey)) {
    throw new Error(`invalid update platform key: ${platformKey}`);
  }
  return `${CUSTOM_UPDATE_CHANNEL_BASE_URL}/manifest-${platformKey}.json?t=${cacheBust}`;
}

function parseAsset(value: unknown, expectedExtension: '.zip' | '.exe'): PlatformAsset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const file = typeof raw.file === 'string' ? raw.file : '';
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256 : '';
  const size = raw.size;
  if (
    !SAFE_ASSET_NAME_RE.test(file) ||
    !file.toLowerCase().endsWith(expectedExtension) ||
    !SHA256_RE.test(sha256) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    return null;
  }
  return { file, sha256: sha256.toLowerCase(), size };
}

/** Parse the fork channel fail-closed before updateService can consume it. */
export function parseCustomUpdateManifest(text: string): Manifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawApp = (raw as Record<string, unknown>).app;
  if (!rawApp || typeof rawApp !== 'object' || Array.isArray(rawApp)) return null;
  const app = rawApp as Record<string, unknown>;
  const version = typeof app.version === 'string' ? app.version : '';
  const hotfix = parseAsset(app.hotfix, '.zip');
  if (!parseStrictVersion(version) || !hotfix) return null;

  const installer = app.installer === undefined ? undefined : parseAsset(app.installer, '.exe');
  if (app.installer !== undefined && !installer) return null;

  return {
    app: {
      version,
      hotfix,
      ...(installer ? { installer } : {}),
      ...(typeof app.releaseNotes === 'string' ? { releaseNotes: app.releaseNotes } : {}),
      ...(app.requireRelogin === true ? { requireRelogin: true } : {}),
    },
  };
}

export async function fetchCustomUpdateManifest(
  timeoutMs = REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Manifest | null> {
  // Defense in depth: callers already skip packaged update flows in dev, but
  // the feed itself must also fail closed so a direct call cannot stage a fork
  // release over an Electron Forge / versioned development build.
  if (isDev() || signal?.aborted) return null;
  const url = getCustomUpdateManifestUrl();
  log.info('Fetching fork app update manifest: %s', url);

  return new Promise<Manifest | null>((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      let bodyBytes = 0;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (value: Manifest | null, abortRequest = false): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        if (abortRequest) request.abort();
        resolve(value);
      };
      const onAbort = (): void => finish(null, true);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => finish(null, true), timeoutMs);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          log.info('HTTP %d for fork update manifest', response.statusCode);
          finish(null);
          return;
        }
        response.on('data', (chunk) => {
          bodyBytes += chunk.length;
          if (bodyBytes > MAX_MANIFEST_BYTES) {
            log.warn('Fork update manifest exceeded %d bytes', MAX_MANIFEST_BYTES);
            finish(null, true);
            return;
          }
          body += chunk.toString();
        });
        response.on('end', () => {
          if (settled) return;
          const manifest = parseCustomUpdateManifest(body);
          if (!manifest) {
            log.warn('Fork update manifest failed strict validation');
            finish(null);
            return;
          }
          log.info('Fetched fork app update manifest v%s', manifest.app.version);
          finish(manifest);
        });
        response.on('error', () => finish(null));
      });
      request.on('error', () => finish(null));
      try {
        request.end();
      } catch {
        finish(null, true);
      }
    } catch {
      resolve(null);
    }
  });
}
