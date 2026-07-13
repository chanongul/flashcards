'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

/** Tag-chip input: typing text and pressing Enter (or comma) turns it into
 * a removable chip, instead of the user having to type commas themselves. */
export function TagsInput({ value, onChange, placeholder }: TagsInputProps) {
  const [draft, setDraft] = useState('');

  function commitDraft() {
    const tag = draft.trim();
    setDraft('');
    if (!tag || value.includes(tag)) return;
    onChange([...value, tag]);
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  // Sorted only for display — the underlying `value` order stays whatever
  // it was (insertion order), since Backspace above removes value's last
  // entry to mean "the most recently added tag", independent of how the
  // chips are currently laid out on screen.
  const sortedValue = [...value].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs">
      {sortedValue.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            aria-label={`Remove tag ${tag}`}
            className="text-neutral-500 hover:text-neutral-200"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {/* text-xs also opts this input into the iOS focus-zoom fix in
          globals.css (which targets input.text-xs/.text-sm) — without it,
          the inherited font-size is under 16px and iOS zooms on focus. */}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitDraft}
        placeholder={value.length === 0 ? placeholder : ''}
        className="min-w-[80px] flex-1 rounded-sm bg-transparent text-xs outline-none placeholder:text-neutral-500"
      />
    </div>
  );
}
