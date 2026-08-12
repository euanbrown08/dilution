import { useCallback, useEffect, useRef, useState } from 'react';

interface DragNumberProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  /** Value change per pixel of horizontal drag. */
  step: number;
  format: (v: number) => string;
  label?: string;
  /** Drag in log space — right for large ranges like valuations. */
  log?: boolean;
}

/**
 * A number you can grab and drag. Click to type. Arrow keys nudge.
 * This is the primary input of the whole piece, so it has to feel immediate:
 * pointer capture, no re-layout while dragging, no text selection.
 */
export function DragNumber({ value, onChange, min, max, step, format, label, log }: DragNumberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, v: 0, moved: false });
  const ref = useRef<HTMLSpanElement>(null);

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, v: value, moved: false };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - start.current.x;
    if (Math.abs(dx) > 2) start.current.moved = true;
    const fine = e.shiftKey ? 0.2 : 1;
    let next: number;
    if (log) {
      // one pixel = a fixed multiplicative step, so £1m and £100m both feel right
      next = start.current.v * Math.exp(dx * 0.006 * fine);
    } else {
      next = start.current.v + dx * step * fine;
    }
    onChange(clamp(next));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
    if (!start.current.moved) {
      setDraft(String(Math.round(value * 1e6) / 1e6));
      setEditing(true);
    }
  };

  useEffect(() => {
    if (editing) ref.current?.querySelector('input')?.focus();
  }, [editing]);

  const commit = () => {
    const n = Number(draft.replace(/[^0-9.eE+-]/g, ''));
    if (Number.isFinite(n)) onChange(clamp(n));
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="dragnum editing" ref={ref}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </span>
    );
  }

  return (
    <span
      className={`dragnum${dragging ? ' dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={format(value)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(e) => {
        const mult = e.shiftKey ? 10 : 1;
        const d = log ? value * 0.02 * mult : step * 10 * mult;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { onChange(clamp(value + d)); e.preventDefault(); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { onChange(clamp(value - d)); e.preventDefault(); }
      }}
    >
      {format(value)}
    </span>
  );
}

export function Toggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="toggle" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
