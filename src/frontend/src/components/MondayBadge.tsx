/** Single chip on a Kanban card showing the task's linked Monday initiative. */
import type { MondayItem } from '@nexus/shared';

interface Props {
  item: MondayItem | undefined;
}

/** Any non-'active' state means the initiative should not read as healthy —
 *  an archived or deleted item is just as stale/misleading to present as a
 *  missing one, so all three degrade the same way, worded for the state. */
function degradedReason(state: MondayItem['state']): string | null {
  switch (state) {
    case 'missing': return 'no longer in Monday';
    case 'archived': return 'archived in Monday';
    case 'deleted': return 'deleted in Monday';
    default: return null;
  }
}

export function MondayBadge({ item }: Props) {
  if (!item) return null;
  const reason = degradedReason(item.state);
  return (
    <span
      title={reason ? `${item.name} — ${reason}` : item.name}
      className={`inline-flex max-w-[12rem] truncate rounded px-1.5 py-0.5 text-[11px] ${
        reason ? 'bg-amber-500/15 text-amber-500' : 'bg-sky-500/15 text-sky-400'
      }`}
    >
      {item.name}
    </span>
  );
}
