import type { GlassSnapshot } from '../shared'
import { attentionEntries, type AttentionEntry } from '../attention'

// Everything the Needs-you list speaks for (#477, slice 7): the sessions blocking
// on a human, then the partner's open attention items. One list, two sources.
export function attentionEntriesOf(snapshot: GlassSnapshot): AttentionEntry[] {
  return attentionEntries(snapshot.sessions, snapshot.attention)
}
