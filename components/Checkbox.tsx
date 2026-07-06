'use client';

import { Check } from 'lucide-react';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Custom-drawn checkbox instead of a native <input> styled via accent-color
 * — mobile WebKit renders accent-color checkboxes with a checkmark that can
 * end up nearly invisible against a light accent (checked state looked like
 * a plain white square). appearance-none strips native rendering entirely
 * so the check icon is always visible against a fixed light fill. */
export function Checkbox({ checked, onChange }: CheckboxProps) {
  return (
    <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer h-4 w-4 shrink-0 cursor-pointer appearance-none rounded border border-neutral-500 bg-transparent checked:border-neutral-100 checked:bg-neutral-100"
      />
      <Check
        size={12}
        strokeWidth={3}
        className="pointer-events-none absolute text-neutral-950 opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}
