/**
 * SelectMenu — a Nexus-styled single-choice picker: a bordered trigger that
 * opens a portalled listbox in the same glass surface as the composer's model
 * and thinking pickers. Replaces native `<select>` where the platform popup
 * (white on macOS) breaks the look of a dark panel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretDown, Check } from '@phosphor-icons/react';

export interface SelectMenuOption {
  value: string;
  label: string;
  /** Optional second line under the label, e.g. a provider or a path. */
  hint?: string;
}

interface SelectMenuProps {
  /** Accessible name of the control; also the listbox label. */
  label: string;
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  /** Trigger text while `value` matches no option. */
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes for the trigger (width, margin). */
  className?: string;
  /** Listbox width in px; defaults to the trigger's width. */
  menuWidth?: number;
}

export default function SelectMenu({ label, value, options, onChange, placeholder = 'Pick one', disabled, className = '', menuWidth }: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<'above' | 'below'>('below');

  const recalcPlacement = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const roomBelow = window.innerHeight - rect.bottom;
    setPlacement(roomBelow < 240 && rect.top > roomBelow ? 'above' : 'below');
  }, []);

  useEffect(() => {
    if (!open) return;
    recalcPlacement();
    function close(e: MouseEvent) {
      if (
        triggerRef.current
        && !triggerRef.current.contains(e.target as Node)
        && !(e.target as HTMLElement).closest('[data-select-menu]')
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onScroll() {
      recalcPlacement();
    }
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, recalcPlacement]);

  const current = options.find((o) => o.value === value);
  const rect = open ? triggerRef.current?.getBoundingClientRect() : undefined;
  const width = menuWidth ?? (rect ? Math.max(rect.width, 160) : 176);
  const style = rect
    ? placement === 'above'
      ? { left: Math.min(rect.left, window.innerWidth - width - 8), bottom: window.innerHeight - rect.top + 4, width }
      : { left: Math.min(rect.left, window.innerWidth - width - 8), top: rect.bottom + 4, width }
    : {};

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 surface-panel border border-subtle rounded-sm px-2 py-1 text-sm text-primary hover:border-[var(--border-strong)] disabled:opacity-50"
      >
        <span className={`flex-1 min-w-0 truncate text-left ${current ? '' : 'text-faint'}`}>{current?.label ?? placeholder}</span>
        <CaretDown className={`w-3 h-3 shrink-0 text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <div
          data-select-menu
          role="listbox"
          aria-label={label}
          className="fixed z-50 rounded-md border border-subtle surface-glass"
          style={style}
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {options.length === 0 && <div className="px-3 py-2 text-xs text-faint">Nothing to pick</div>}
            {options.map((o) => {
              const isCurrent = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-primary hover:bg-[var(--surface-hover)]"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{o.label}</span>
                    {o.hint && <span className="block text-[10px] text-faint truncate">{o.hint}</span>}
                  </span>
                  {isCurrent && <Check className="w-3 h-3 shrink-0 accent-text" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
