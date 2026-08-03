export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  [key: string]: unknown;
}

export interface AccessTokenInfo {
  token: string;
  projectId: string | null;
  clientEmail: string;
  /** epoch ms, or null if the library did not expose an expiry */
  expiresAt: number | null;
}

export interface SendOptions {
  /** Override the service account's project_id */
  projectId?: string;
  /** true => FCM validate_only (does not deliver, only validates) */
  dryRun?: boolean;
}

export interface SavedSource {
  type: 'path' | 'pasted';
  path?: string | null;
}

export interface SavedConfig {
  savedAt: string;
  source: SavedSource;
  summary: { clientEmail: string; projectId: string | null };
  serviceAccount?: ServiceAccount;
}

/** `source` can be a file path, pasted JSON content, or a credentials object. */
export type Source = string | ServiceAccount;

/** Load + validate a service account from a path, JSON content, or object. */
export function loadServiceAccount(source: Source): ServiceAccount;

/** Get an OAuth2 access token. Cached (~1h) + auto-refresh. */
export function getAccessToken(source: Source): Promise<AccessTokenInfo>;

/**
 * Send an FCM v1 message.
 * @param message FCM v1 "message" object (token/topic/condition + notification/data)
 */
export function sendPush(
  source: Source,
  message: Record<string, unknown>,
  options?: SendOptions
): Promise<Record<string, unknown>>;

/** Remember a service account for later runs. */
export function saveLastAccount(
  sa: ServiceAccount,
  source: SavedSource
): string;

/** Load the saved config, or null if none. */
export function loadLastAccount(): SavedConfig | null;

/** Turn a saved config into a `source` usable by getAccessToken/sendPush. */
export function savedSource(saved: SavedConfig): Source;

/** Forget the saved service account. Returns true if something was removed. */
export function forgetLastAccount(): boolean;

/** Path to the saved config file. */
export function configFile(): string;

/** Clear the in-memory token client cache. */
export function clearCache(): void;

export const FCM_SCOPE: string;
