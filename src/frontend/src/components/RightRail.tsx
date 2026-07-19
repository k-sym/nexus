import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
  resizable?: boolean;
}

const MIN_RAIL_WIDTH = 240;
const MAX_RAIL_WIDTH = 720;

export default function RightRail({ label, title, open, onOpenChange, actions, footer, children, ariaLabel, resizable = false }: RightRailProps) {
  const [width, setWidth] = useState(288);
  const [resizing, setResizing] = useState(false);

  const resizeTo = useCallback((clientX: number) => {
    if (!Number.isFinite(clientX)) return;
    const availableWidth = Math.max(MIN_RAIL_WIDTH, window.innerWidth - 320);
    setWidth(Math.min(MAX_RAIL_WIDTH, availableWidth, Math.max(MIN_RAIL_WIDTH, window.innerWidth - clientX)));
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const handleMove = (event: PointerEvent) => resizeTo(event.clientX);
    const handleUp = () => setResizing(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [resizeTo, resizing]);
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
      className="relative shrink-0 border-l border-subtle surface-glass flex flex-col min-h-0"
      style={{ width }}
      aria-label={ariaLabel ?? title}
    >
      {resizable && (
        <div
          role="separator"
          aria-label={`Resize ${label.toLowerCase()}`}
          aria-orientation="vertical"
          aria-valuemin={MIN_RAIL_WIDTH}
          aria-valuemax={MAX_RAIL_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            setResizing(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setWidth((current) => Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, current + (event.key === 'ArrowLeft' ? 24 : -24))));
          }}
          className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none focus:outline-hidden"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--border-strong)] group-focus:bg-[var(--accent)]" />
        </div>
      )}
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
