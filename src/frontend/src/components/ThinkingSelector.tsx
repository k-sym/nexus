/**
 * ThinkingSelector — compact Pi thinking-level picker for the chat composer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretUp, Check } from '@phosphor-icons/react';
import {
  thinkingLevelLabel,
  type ThinkingLevel,
} from '../lib/thinking';

interface ThinkingSelectorProps {
  levels: ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
}

export function ThinkingSelector({ levels, value, onChange, disabled }: ThinkingSelectorProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<'above' | 'below'>('above');

  const recalcPlacement = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlacement(rect.top > 240 ? 'above' : 'below');
  }, []);

  useEffect(() => {
    if (!open) return;
    recalcPlacement();
    function close(e: MouseEvent) {
      if (
        triggerRef.current
        && !triggerRef.current.contains(e.target as Node)
        && !(e.target as HTMLElement).closest('[data-thinking-dropdown]')
      ) {
        setOpen(false);
      }
    }
    function onScroll() {
      recalcPlacement();
    }
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, recalcPlacement]);

  if (levels.length === 0) return null;

  const label = `Thinking: ${thinkingLevelLabel(value)}`;

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        data-testid="thinking-selector"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md border border-subtle surface-panel px-2.5 py-1 text-xs text-primary hover:border-[var(--border-strong)] disabled:opacity-50"
      >
        <span className="max-w-[160px] truncate">{label}</span>
        <CaretUp className={`w-3 h-3 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
      {open && createPortal(
        <div
          data-thinking-dropdown
          data-testid="thinking-dropdown-list"
          role="listbox"
          aria-label="Thinking level"
          className={`fixed z-50 w-44 rounded-md border border-subtle surface-glass ${
            placement === 'above' ? 'mb-1' : 'mt-1'
          }`}
          style={
            placement === 'above'
              ? (() => {
                  const rect = triggerRef.current?.getBoundingClientRect();
                  return rect
                    ? {
                        left: Math.min(rect.left, window.innerWidth - 188),
                        bottom: window.innerHeight - rect.top + 4,
                        width: 176,
                      }
                    : {};
                })()
              : (() => {
                  const rect = triggerRef.current?.getBoundingClientRect();
                  return rect
                    ? {
                        left: Math.min(rect.left, window.innerWidth - 188),
                        top: rect.bottom + 4,
                        width: 176,
                      }
                    : {};
                })()
          }
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {levels.map((level) => {
              const isCurrent = level === value;
              return (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  onClick={() => {
                    onChange(level);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-primary hover:bg-[var(--surface-hover)]"
                >
                  <span className="flex-1 truncate">{thinkingLevelLabel(level)}</span>
                  {isCurrent && <Check className="w-3 h-3 accent-text" />}
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
