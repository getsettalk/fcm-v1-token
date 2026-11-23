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

/** What to show/deliver — everything except the target. */
export interface MessageContent {
  /** Notification title (a notification needs a title or a body). */
  title?: string;
  /** Notification body. */
  body?: string;
  /** http(s) image URL — set for Android, iOS (needs a service extension) and web. */
  image?: string;
  /** Custom key/value data. Non-string values are JSON-encoded. */
  data?: Record<string, unknown>;
  /** true => silent data message (no title/body/image); needs `data`. */
  dataOnly?: boolean;
  /** Notification sound; default "default". Use "none" (or false) for no sound field. */
  sound?: string | false;
  /** Android notification channel id. */
  channelId?: string;
  /** Android click_action / iOS category. */
  clickAction?: string;
  /** Delivery priority; default "high". */
  priority?: 'high' | 'normal';
}

/** buildMessage() options: content plus exactly one target. */
export interface BuildMessageOptions extends MessageContent {
  /** Device registration token. */
  token?: string;
  /** Topic name, e.g. "news" (a "/topics/" prefix is accepted). */
  topic?: string;
  /** Topic condition, e.g. "'news' in topics && 'sports' in topics". */
  condition?: string;
}

/** Build a cross-platform FCM v1 message (Android, iOS, web) from simple options. */
export function buildMessage(options: BuildMessageOptions): Record<string, unknown>;

/**
 * Send a notification or data-only message to every device subscribed to a topic.
 * Resolves to the FCM response, e.g. { name: 'projects/x/messages/123' }.
 */
export function sendToTopic(
  source: Source,
  topic: string,
  content: MessageContent,
  options?: SendOptions
): Promise<Record<string, unknown>>;

/** Validate a topic name and strip an optional "/topics/" prefix. */
export function normalizeTopic(topic: string): string;

/** Turn data into FCM's string-to-string map; throws on reserved keys. */
export function normalizeData(
  data: Record<string, unknown> | null | undefined
): Record<string, string> | undefined;

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
