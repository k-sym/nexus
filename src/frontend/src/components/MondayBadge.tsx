/** Single chip on a Kanban card showing the task's linked Monday initiative. */
import type { MondayItem } from '@nexus/shared';

interface Props {
  item: MondayItem | undefined;
}

export function MondayBadge({ item }: Props) {
  if (!item) return null;
  const unavailable = item.state === 'missing';
  return (
    <span
      title={unavailable ? `${item.name} — no longer in Monday` : item.name}
      className={`inline-flex max-w-[12rem] truncate rounded px-1.5 py-0.5 text-[11px] ${
        unavailable ? 'bg-amber-500/15 text-amber-500' : 'bg-sky-500/15 text-sky-400'
      }`}
    >
      {item.name}
    </span>
  );
}
