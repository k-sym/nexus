import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';

export interface RailTab { id: string; label: string }

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
  /** When given, the header shows these tabs in place of the title. */
  tabs?: RailTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  initialWidth?: number;
}

const MIN_RAIL_WIDTH = 240;
const MAX_RAIL_WIDTH = 720;

export default function RightRail({ label, title, open, onOpenChange, actions, footer, children, ariaLabel, resizable = false, tabs, activeTab, onTabChange, initialWidth = 288 }: RightRailProps) {
  const [width, setWidth] = useState(initialWidth);
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

  // Arrow keys select the neighbouring tab and move focus with it: the old
  // button drops to tabIndex -1 on re-render, so focus must not be left there.
  const moveTab = (list: HTMLElement, delta: number) => {
    if (!tabs?.length || !onTabChange) return;
    const index = Math.max(0, tabs.findIndex((tab) => tab.id === activeTab));
    const next = (index + delta + tabs.length) % tabs.length;
    onTabChange(tabs[next].id);
    (list.children[next] as HTMLElement | undefined)?.focus();
  };

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
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-subtle">
        {tabs && tabs.length > 0 ? (
          <div
            role="tablist"
            aria-label={`${label} tabs`}
            className="flex min-w-0 items-center gap-1 overflow-x-auto"
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              moveTab(event.currentTarget, event.key === 'ArrowLeft' ? -1 : 1);
            }}
          >
            {tabs.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onTabChange?.(tab.id)}
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    selected ? 'surface-panel border-strong text-primary' : 'border-transparent text-faint hover:text-[var(--text-primary)]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="min-w-0 truncate px-1 text-[10px] uppercase tracking-wider text-faint font-medium">{title}</span>
        )}
        <div className="flex shrink-0 items-center gap-2 pr-1">
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
