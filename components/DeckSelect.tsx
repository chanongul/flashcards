'use client';

import { ChevronDown } from 'lucide-react';
import { deckDisplayName, type DeckTreeRow } from '@/lib/decks';

interface DeckSelectProps {
  rows: DeckTreeRow[];
  value: string;
  onChange: (deckId: string) => void;
  label?: string;
  // e.g. a "(Top level)" option for a deck-move picker, where "" means no
  // parent — not every caller needs this (a card always belongs to some
  // real deck, so CardRow's move/clone pickers never pass it).
  emptyOption?: { value: string; label: string };
}

// The indented, depth-aware <select> shared by every "pick a deck" flow —
// duplicated three times (CardRow's clone picker, CardRow's move picker,
// the deck-move picker in app/page.tsx) before being pulled out here.
export function DeckSelect({ rows, value, onChange, label, emptyOption }: DeckSelectProps) {
  const select = (
    <div className="relative mt-0.5">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 pr-8 text-sm"
      >
        {emptyOption && <option value={emptyOption.value}>{emptyOption.label}</option>}
        {rows.map(({ deck, depth }) => (
          <option key={deck.id} value={deck.id}>
            {'  '.repeat(depth)}
            {deckDisplayName(deck.name)}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500"
      />
    </div>
  );

  if (!label) return select;
  return (
    <label className="block">
      <span className="text-xs text-neutral-500">{label}</span>
      {select}
    </label>
  );
}
