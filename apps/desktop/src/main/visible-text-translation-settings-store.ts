/**
 * Owner-global visible text translation settings.
 *
 * File: <userData>/owners/<owner>/visible-text-translation-settings.json
 * This scope deliberately crosses projects, dialogues and windows without
 * crossing Cindy account/data-owner boundaries. No credential is stored here.
 */

import type { AgentKind } from '@cindy/maker-core';

import { activeOwnerScopeKey, ownerScopedUserDataPath } from './appSessionState.js';
import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('visible-text-translation-settings');

export interface VisibleTextTranslationSettings {
  enabled: boolean;
  providerId: string;
  agentKind: Extract<AgentKind, 'claude-code' | 'codex'>;
  model: string;
}

const DEFAULTS: VisibleTextTranslationSettings = {
  enabled: false,
  providerId: 'openrouter',
  agentKind: 'codex',
  model: 'google/gemini-3.5-flash-lite',
};

function settingsFilePath(): string {
  return ownerScopedUserDataPath('visible-text-translation-settings.json');
}

function normalizeIdentifier(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : fallback;
}

function normalize(raw: unknown): VisibleTextTranslationSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const value = raw as Record<string, unknown>;
  return {
    enabled: value.enabled === true,
    providerId: normalizeIdentifier(value.providerId, DEFAULTS.providerId, 128),
    agentKind: value.agentKind === 'claude-code' ? 'claude-code' : 'codex',
    model: normalizeIdentifier(value.model, DEFAULTS.model, 256),
  };
}

const store = createOverrideSettingsFile<VisibleTextTranslationSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'visible text translation',
  scopeKey: activeOwnerScopeKey,
  maxBytes: 16 * 1_024,
  preserveUnreadableFile: true,
});

export function readVisibleTextTranslationSettings(): VisibleTextTranslationSettings {
  // The file is intentionally hand-editable even before a Settings UI exists.
  store.invalidateIfChanged();
  return store.read();
}

export function writeVisibleTextTranslationSettings(
  patch: Partial<VisibleTextTranslationSettings>,
): VisibleTextTranslationSettings {
  // Preserve an explicit user choice even when it currently equals the system
  // default; a future default change must not silently move this configuration.
  store.writePatch(patch, { preserveDefaults: true });
  return store.read();
}

export const __testing = { normalize, DEFAULTS };
