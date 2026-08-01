/**
 * Typed chrome.storage.local access. Unencrypted at rest (no OS keychain
 * equivalent exists for a browser extension) - the options UI shows a warning
 * before the first key is saved; sidecar mode never stores a DB password here,
 * only a base URL and an optional auth header.
 */
import type { ProviderName } from '@asksql/core';
import { removeAllGrantedOriginPermissions } from './permissions.js';
import { removeAllPersistedDatabases } from './persistence.js';
import { clearProviderOriginStripRule } from './originHeaderRule.js';

export interface ProviderSettings {
  readonly provider: ProviderName;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
}

export interface EngineSettings {
  readonly maxRows: number;
  readonly requireApproval: boolean;
  readonly sqlDisplayPlacement: 'before' | 'after';
  readonly answerSchemaQuestions: boolean;
  /** Cap on schema text sent per question; core halves and retries once on overflow. */
  readonly maxSchemaTokens: number;
  /** Appended to the built-in rules. The AST guard still enforces read-only regardless. */
  readonly customInstructions: string;
}

export interface SidecarConnection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly authHeader?: string;
  /**
   * Set when this entry was created by sending database details to the server,
   * so the side panel can ask that server for this database specifically rather
   * than whatever it happens to expose first.
   */
  readonly remoteConnectionId?: string;
  readonly engine?: string;
  readonly database?: string;
}

export interface AskSqlSettings {
  readonly provider: ProviderSettings;
  readonly engine: EngineSettings;
  readonly connections: readonly SidecarConnection[];
  readonly warningAcknowledged: boolean;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  maxRows: 200,
  requireApproval: false,
  sqlDisplayPlacement: 'after',
  answerSchemaQuestions: true,
  maxSchemaTokens: 6000,
  customInstructions: '',
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  provider: 'ollama',
  model: '',
};

const KEYS = {
  provider: 'asksql.provider',
  engine: 'asksql.engine',
  connections: 'asksql.connections',
  warningAcknowledged: 'asksql.warningAcknowledged',
  lastConnection: 'asksql.lastConnection',
} as const;

export async function getProviderSettings(): Promise<ProviderSettings> {
  const got = await chrome.storage.local.get([KEYS.provider]);
  const stored = got[KEYS.provider] as Partial<ProviderSettings> | undefined;
  return { ...DEFAULT_PROVIDER_SETTINGS, ...stored };
}

export async function setProviderSettings(settings: ProviderSettings): Promise<void> {
  await chrome.storage.local.set({ [KEYS.provider]: settings });
}

export async function getEngineSettings(): Promise<EngineSettings> {
  const got = await chrome.storage.local.get([KEYS.engine]);
  const stored = got[KEYS.engine] as Partial<EngineSettings> | undefined;
  return { ...DEFAULT_ENGINE_SETTINGS, ...stored };
}

export async function setEngineSettings(settings: EngineSettings): Promise<void> {
  await chrome.storage.local.set({ [KEYS.engine]: settings });
}

export async function getConnections(): Promise<SidecarConnection[]> {
  const got = await chrome.storage.local.get([KEYS.connections]);
  return (got[KEYS.connections] as SidecarConnection[] | undefined) ?? [];
}

export async function setConnections(connections: readonly SidecarConnection[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.connections]: connections });
}

export async function addConnection(connection: SidecarConnection): Promise<SidecarConnection[]> {
  const existing = await getConnections();
  const next = [...existing.filter((c) => c.id !== connection.id), connection];
  await setConnections(next);
  return next;
}

export async function removeConnection(id: string): Promise<SidecarConnection[]> {
  const next = (await getConnections()).filter((c) => c.id !== id);
  await setConnections(next);
  return next;
}

export async function getWarningAcknowledged(): Promise<boolean> {
  const got = await chrome.storage.local.get([KEYS.warningAcknowledged]);
  return got[KEYS.warningAcknowledged] === true;
}

export async function setWarningAcknowledged(acknowledged: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.warningAcknowledged]: acknowledged });
}

/** Which connection the panel had open last, so reopening it lands back there rather than on a picker. */
export async function getLastConnectionId(): Promise<string | undefined> {
  const got = await chrome.storage.local.get([KEYS.lastConnection]);
  const id = got[KEYS.lastConnection];
  return typeof id === 'string' ? id : undefined;
}

export async function setLastConnectionId(id: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.lastConnection]: id });
}

/** Defaults provider/engine settings but keeps connections - re-entering a database is far more work than re-picking a model. */
export async function resetSettingsToDefaults(): Promise<void> {
  await chrome.storage.local.remove([KEYS.provider, KEYS.engine, KEYS.warningAcknowledged]);
  await clearProviderOriginStripRule();
}

/** Full reset: all storage, granted origin permissions, persisted databases, and the DNR rule. */
export async function resetAll(): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await removeAllGrantedOriginPermissions();
  await removeAllPersistedDatabases();
  await clearProviderOriginStripRule();
}
