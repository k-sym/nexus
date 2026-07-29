import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantAttachment, AssistantMessage } from './useAssistantStream';

// The module hydrates its in-memory list from localStorage at import time, so a
// fresh import gives isolated state — and doubles as a "page reload" simulation.
async function freshCache() {
  vi.resetModules();
  return import('./assistantAttachmentCache');
}

const img = (name: string): AssistantAttachment => ({ type: 'image', data: 'Zm9v', mimeType: 'image/jpeg', name });
const file = (name: string): AssistantAttachment => ({ type: 'file', data: 'YmlnZmlsZWJ5dGVz', mimeType: 'text/plain', name });
const user = (content: string): AssistantMessage => ({ id: content, role: 'user', content, created_at: 't' });
const asst = (content: string): AssistantMessage => ({ id: content, role: 'assistant', content, created_at: 't' });

describe('assistantAttachmentCache', () => {
  beforeEach(() => localStorage.clear());

  it('re-attaches by user ordinal, tolerating backend-augmented file content', async () => {
    const cache = await freshCache();
    cache.recordAttachments('s1', 0, [img('a.jpg')]);
    cache.recordAttachments('s1', 1, [file('notes.txt')]);

    const loaded: AssistantMessage[] = [
      asst('hi'),
      user('look'),
      asst('nice'),
      user('summarize\n\nAttached files:\n- notes.txt: /uploads/notes.txt'),
    ];
    const users = cache.reattachAttachments(loaded, 's1').filter((m) => m.role === 'user');
    expect(users[0].attachments?.[0]).toMatchObject({ type: 'image', name: 'a.jpg' });
    expect(users[1].attachments?.[0]).toMatchObject({ type: 'file', name: 'notes.txt' });
  });

  it('persists across a fresh module load (survives a reload)', async () => {
    let cache = await freshCache();
    cache.recordAttachments('s1', 0, [img('a.jpg')]);
    cache = await freshCache(); // re-import == page reload re-reading localStorage
    const out = cache.reattachAttachments([user('look')], 's1');
    expect(out[0].attachments?.[0]).toMatchObject({ name: 'a.jpg' });
  });

  it('drops file bytes but keeps image data', async () => {
    const cache = await freshCache();
    cache.recordAttachments('s1', 0, [file('big.pdf')]);
    cache.recordAttachments('s1', 1, [img('pic.jpg')]);
    const out = cache.reattachAttachments([user('a'), user('b')], 's1');
    expect(out[0].attachments?.[0].data).toBe('');      // file bytes dropped
    expect(out[1].attachments?.[0].data).toBe('Zm9v');  // image data kept
  });

  it('purges a session', async () => {
    const cache = await freshCache();
    cache.recordAttachments('s1', 0, [img('a.jpg')]);
    cache.purgeSession('s1');
    expect(cache.reattachAttachments([user('look')], 's1')[0].attachments).toBeUndefined();
  });

  it('never clobbers attachments the payload already carries', async () => {
    const cache = await freshCache();
    cache.recordAttachments('s1', 0, [img('cached.jpg')]);
    const withOwn: AssistantMessage = { ...user('look'), attachments: [img('own.jpg')] };
    expect(cache.reattachAttachments([withOwn], 's1')[0].attachments?.[0].name).toBe('own.jpg');
  });

  it('nextUserOrdinal counts user rows', async () => {
    const cache = await freshCache();
    expect(cache.nextUserOrdinal([asst('hi'), user('a'), asst('b')])).toBe(1);
  });
});
