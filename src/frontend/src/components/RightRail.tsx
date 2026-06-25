import type { ReactNode } from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';

interface RightRailProps {
  label: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
}

export default function RightRail({ label, title, open, onOpenChange, actions, footer, children, ariaLabel }: RightRailProps) {
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        title={`Show ${label.toLowerCase()}`}
        className="shrink-0 w-8 border-l border-subtle surface-glass flex flex-col items-center justify-center gap-2 text-faint hover:text-[var(--text-primary)] transition-colors"
      >
        <CaretLeft size={16} />
        <span className="text-[10px] uppercase tracking-wider [writing-mode:vertical-rl]">{label}</span>
      </button>
    );
  }

  return (
    <aside
      className="shrink-0 w-72 border-l border-subtle surface-glass flex flex-col min-h-0"
      aria-label={ariaLabel ?? title}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-subtle">
        <span className="min-w-0 truncate text-[10px] uppercase tracking-wider text-faint font-medium">{title}</span>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title="Collapse"
            className="text-faint hover:text-[var(--text-primary)] transition-colors"
          >
            <CaretRight size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 min-h-0">{children}</div>
      {footer && <div className="border-t border-subtle p-2">{footer}</div>}
    </aside>
  );
}
