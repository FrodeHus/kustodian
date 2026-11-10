import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { DEFAULT_TIMESPAN } from '../tabs/tab-store';
import { DAY_MS, interval } from './timespan';

/** The timespans the menu offers (spec 8.1: 1, 7 or 30 days, or custom). */
const PRESETS = [
  { value: 'P1D', label: '1 day' },
  { value: 'P7D', label: '7 days' },
  { value: 'P30D', label: '30 days' },
  { value: 'P90D', label: '90 days' },
] as const;

/** A workspace keeps data longer than Defender's 30 days, so the 90 days preset shows only when the cap allows it. */
const presetsFor = (maxDays: number) => PRESETS.filter((p) => maxDays > 30 || p.value !== 'P90D');

/** An instant as a `datetime-local` input shows it, in local time to the minute. */
function toLocalInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** An instant as the interval sends it: UTC to the second. */
const toIso = (at: Date) => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

const short = (at: Date) => at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const isPreset = (timespan: string) => PRESETS.some((p) => p.value === timespan);

/** What the trigger says: a preset's name, a custom range's dates, or a stored timespan as it is written. */
function timespanText(timespan: string): string {
  const preset = PRESETS.find((p) => p.value === timespan);
  if (preset) {
    return preset.label;
  }
  const range = interval(timespan);
  return range ? `${short(range[0])} – ${short(range[1])}` : timespan;
}

/** Why a custom range can't be used, or null when it can: the start before the end, and `maxDays` at most (the host's rule). */
function rangeProblem(start: string, end: string, maxDays: number): string | null {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return 'Pick a start and an end.';
  }
  if (to <= from) {
    return 'The end must come after the start.';
  }
  return to - from > maxDays * DAY_MS ? `The timespan can cover at most ${maxDays} days.` : null;
}

/** A mousedown doesn't move focus, so a click lands even where WebKit wouldn't focus the button; the range's fields still take
 * it. */
const keepFocus = (e: ReactMouseEvent) => {
  if (!(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
  }
};

interface TimespanPickerProps {
  /** The tab's timespan; none is the default, 30 days. */
  timespan: string | null | undefined;
  onChange: (timespan: string) => void;
  /** The longest timespan: 30 days for Defender's data, 730 with a workspace. */
  maxDays: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The advanced hunting tab's timespan (mockup: Hunting; spec 8.1): 1, 7 or 30 days, or a custom range of 30 days at most, sent
 * as an interval `start/end`. The menu closes on a click outside it or Esc, never on blur (macOS WebKit doesn't focus a clicked
 * button), and a mousedown in it doesn't move focus, except into the range's fields.
 */
export function TimespanPicker({ timespan, onChange, maxDays, open, onOpenChange }: TimespanPickerProps) {
  const current = timespan ?? DEFAULT_TIMESPAN;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) {
        onOpenChange(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="btn whitespace-nowrap"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onOpenChange(!open)}
      >
        Timespan: {timespanText(current)} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <TimespanMenu
          current={current}
          maxDays={maxDays}
          onChoose={(value) => {
            onChange(value);
            onOpenChange(false);
          }}
        />
      )}
    </div>
  );
}

/** The open menu: mounted each time it opens, so it starts on the presets. */
function TimespanMenu({ current, maxDays, onChoose }: { current: string; maxDays: number; onChoose: (timespan: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const startField = useRef<HTMLInputElement>(null);
  const customItem = useRef<HTMLButtonElement>(null);
  /** The custom form has been shown: coming back from it puts focus on "Custom…", not on the checked item. */
  const wasCustom = useRef(false);

  // Focus goes where the menu now is: the checked item when it opens, the form's first field after "Custom…", and "Custom…"
  // again after "Back".
  useEffect(() => {
    if (custom) {
      wasCustom.current = true;
      startField.current?.focus();
    } else if (wasCustom.current) {
      customItem.current?.focus();
    } else {
      ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    }
  }, [custom]);

  const startCustom = () => {
    // The range shown first: the tab's own, or the last 7 days.
    const range = interval(current);
    const to = range?.[1] ?? new Date();
    const from = range?.[0] ?? new Date(to.getTime() - 7 * DAY_MS);
    setStart(toLocalInput(from));
    setEnd(toLocalInput(to));
    setProblem(null);
    setCustom(true);
  };

  const applyRange = () => {
    const why = rangeProblem(start, end, maxDays);
    setProblem(why);
    if (!why) {
      onChoose(`${toIso(new Date(start))}/${toIso(new Date(end))}`);
    }
  };

  if (custom) {
    return (
      <div
        className="menu"
        role="dialog"
        aria-label="Custom timespan"
        style={{ left: 0, top: 36, width: 300, padding: 12, gap: 8 }}
        onMouseDown={keepFocus}
      >
        <label className="flex items-center gap-2 text-[12px]">
          <span className="w-10">Start</span>
          <input
            ref={startField}
            className="textbox h-[28px] flex-1"
            type="datetime-local"
            aria-label="Start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <span className="w-10">End</span>
          <input
            className="textbox h-[28px] flex-1"
            type="datetime-local"
            aria-label="End"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        {problem && (
          <span role="alert" className="text-[12px] text-bad">
            {problem}
          </span>
        )}
        <span className="faint text-[12px]">
          {maxDays > 30 ? `A workspace keeps data for up to ${maxDays} days.` : 'Advanced hunting keeps 30 days of data.'} The timespan is
          saved with the query.
        </span>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn ghost" onClick={() => setCustom(false)}>
            Back
          </button>
          <button type="button" className="btn primary" onClick={applyRange}>
            Use this range
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label="Timespan"
      style={{ left: 0, top: 36, width: 200 }}
      onMouseDown={keepFocus}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
          return;
        }
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
        const at = items.findIndex((b) => b === document.activeElement);
        items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}
    >
      {presetsFor(maxDays).map((p) => (
        <button
          key={p.value}
          type="button"
          role="menuitemradio"
          aria-checked={current === p.value}
          className={current === p.value ? 'on' : undefined}
          onClick={() => onChoose(p.value)}
        >
          {p.label}
        </button>
      ))}
      <button
        ref={customItem}
        type="button"
        role="menuitemradio"
        aria-checked={!isPreset(current)}
        className={isPreset(current) ? undefined : 'on'}
        onClick={startCustom}
      >
        Custom…
      </button>
    </div>
  );
}
