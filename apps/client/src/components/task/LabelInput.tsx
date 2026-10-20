import { LIMITS, normalizeLabels } from '@syncboard/shared';
import { XIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { labelStyle } from '@/lib/taskMeta';

export function LabelInput({ value, onChange, disabled, suggestions = [] }: { value: string[]; onChange: (labels: string[]) => void; disabled?: boolean; suggestions?: string[] }) {
  const [draft, setDraft] = useState('');
  const full = value.length >= LIMITS.labelsPerTask;

  const add = (raw: string) => {
    const label = raw.trim().slice(0, LIMITS.labelMax);
    if (!label) return;
    onChange(normalizeLabels([...value, label]).slice(0, LIMITS.labelsPerTask));
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add(draft);
    } else if (event.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };
  const unused = suggestions.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase())).slice(0, 6);

  return (
    <div className="grid gap-1.5">
      <div className={cn('flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-card px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30', disabled && 'opacity-50')}>
        {value.map((label) => (
          <span key={label} className="label-chip inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium" style={labelStyle(label) as React.CSSProperties}>
            {label}
            {!disabled && (
              <button type="button" onClick={() => onChange(value.filter((l) => l !== label))} aria-label={`Remove label ${label}`} className="rounded hover:bg-black/5">
                <XIcon className="size-3" />
              </button>
            )}
          </span>
        ))}
        <input
          value={draft}
          disabled={disabled || full}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
          maxLength={LIMITS.labelMax}
          placeholder={full ? 'Label limit reached' : value.length ? '' : 'Add labels…'}
          aria-label="Add label"
          className="min-w-20 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/80"
        />
      </div>
      {unused.length > 0 && !disabled && !full && (
        <div className="flex flex-wrap gap-1">
          {unused.map((label) => (
            <button key={label} type="button" onClick={() => add(label)} className="rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
              + {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
