import type { AssistantAttachment, AssistantMessage } from './useAssistantStream';

// Sent-attachment thumbnails, cached client-side and keyed by (sessionId, user
// message ordinal). The backend transcript is text-only — images go inline to
// the model and file names get appended to the message content — so on every
// reload the sent attachments would otherwise vanish from the user's own turn.
// Keyed by ordinal, not content, precisely because the file path suffix mutates
// the content. Persisted to localStorage so thumbnails also survive a full
// reload/restart of the app; a byte budget + quota-error fallback keep it from
// ever wedging on a full store.

const STORAGE_KEY = 'nexus.assistant.attachmentCache';
const MAX_BYTES = 3 * 1024 * 1024; // stay well under the ~5 MB localStorage quota

interface Entry {
  sessionId: string;
  ordinal: number;
  attachments: AssistantAttachment[];
}

function readStore(): Entry[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  } catch {
    return [];
  }
}

// Oldest-first insertion order, so eviction drops the least-recently-sent sets.
let entries: Entry[] = readStore();

function bytesOf(entry: Entry): number {
  return entry.attachments.reduce((sum, a) => sum + (a.data?.length ?? 0) + (a.name?.length ?? 0), 0);
}

function persist(): void {
  // Trim to the byte budget, then write — retrying against a genuinely full
  // store (QuotaExceededError) by dropping the oldest set each attempt.
  while (entries.length > 0 && entries.reduce((sum, e) => sum + bytesOf(e), 0) > MAX_BYTES) {
    entries.shift();
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      return;
    } catch {
      if (entries.length === 0) return;
      entries.shift();
    }
  }
}

// Keep only what the bubble renders: images need their base64 for the thumbnail;
// files render as a name+type chip, so drop the (potentially large) file bytes.
function slim(attachment: AssistantAttachment): AssistantAttachment {
  if (attachment.type === 'image') {
    return {
      type: 'image',
      data: attachment.data,
      mimeType: attachment.mimeType,
      ...(attachment.name ? { name: attachment.name } : {}),
    };
  }
  return { type: 'file', data: '', mimeType: attachment.mimeType, name: attachment.name };
}

/** Cache the attachments sent on the user message at `ordinal` in `sessionId`. */
export function recordAttachments(sessionId: string, ordinal: number, attachments: AssistantAttachment[]): void {
  if (!sessionId || attachments.length === 0) return;
  const idx = entries.findIndex((e) => e.sessionId === sessionId && e.ordinal === ordinal);
  if (idx >= 0) entries.splice(idx, 1);
  entries.push({ sessionId, ordinal, attachments: attachments.map(slim) });
  persist();
}

/** Drop a session's cached attachments (on hard delete). */
export function purgeSession(sessionId: string): void {
  const next = entries.filter((e) => e.sessionId !== sessionId);
  if (next.length !== entries.length) {
    entries = next;
    persist();
  }
}

/**
 * Re-attach cached thumbnails onto a freshly-loaded (text-only) transcript,
 * matching each user row to its 0-based ordinal among user rows. Never clobbers
 * attachments the payload already carries (e.g. the legacy local path).
 */
export function reattachAttachments(messages: AssistantMessage[], sessionId: string): AssistantMessage[] {
  const byOrdinal = new Map<number, AssistantAttachment[]>();
  for (const entry of entries) {
    if (entry.sessionId === sessionId) byOrdinal.set(entry.ordinal, entry.attachments);
  }
  if (byOrdinal.size === 0) return messages;

  let userOrdinal = 0;
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const cached = byOrdinal.get(userOrdinal);
    userOrdinal += 1;
    if (!cached || cached.length === 0 || (message.attachments && message.attachments.length > 0)) {
      return message;
    }
    return { ...message, attachments: cached };
  });
}

/** The next user message's ordinal — its index among the current user rows. */
export function nextUserOrdinal(messages: AssistantMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0);
}
