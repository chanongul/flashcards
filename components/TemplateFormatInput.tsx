'use client';

// A note type's field-name template editor (see app/page.tsx's note-type
// create/edit form) — lets the user pre-style a field's *name* with the
// starter formatting a brand-new card's blank field should begin with
// (NoteType.fieldTemplates). Every toolbar action here always applies to
// the whole name string at once, never a partial selection — there's no
// live caret/selection concept at all, just a plain text input plus
// readTextFormat/buildFormattedText round-tripping the current whole-string
// format (the same functions ChoiceFieldInput already uses for its picked
// option's formatting). Previously RichTextInput's `formatEntireValue`
// mode did this job; a plain input needs none of a live editor's
// selection-tracking machinery to do the exact same "reformat the whole
// string" operation, so it doesn't need to route through either rich text
// widget at all.
import { Bold, Italic, Underline, EyeDashed, Baseline, CaseUpper, CaseLower } from 'lucide-react';
import type { TextFormat } from '@/lib/db';
import { stripHtml } from '@/lib/sanitize';
import { COLOR_PALETTE, MIN_SIZE, MAX_SIZE, NORMAL_SIZE } from '@/lib/richTextModel';
import { readTextFormat, buildFormattedText } from './MediaFieldInput';
import { DropdownMenu } from './base/DropdownMenu';

interface TemplateFormatInputProps {
  value: string; // sanitized HTML (the name, whole-string formatted)
  onChange: (html: string) => void;
  placeholder?: string;
}

export function TemplateFormatInput({ value, onChange, placeholder }: TemplateFormatInputProps) {
  const text = stripHtml(value);
  const format = readTextFormat(value);

  function applyFormat(patch: Partial<TextFormat>) {
    onChange(buildFormattedText(text, { ...format, ...patch }));
  }

  function stepSize(delta: number) {
    const next = Math.min(MAX_SIZE, Math.max(MIN_SIZE, format.size + delta));
    if (next !== format.size) applyFormat({ size: next });
  }

  function applyTextTransform(fn: (s: string) => string) {
    onChange(buildFormattedText(fn(text), format));
  }

  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex flex-wrap gap-1 border-b border-neutral-700 p-1">
        <button
          type="button"
          onClick={() => applyFormat({ bold: !format.bold })}
          aria-label="Bold"
          aria-pressed={format.bold}
          className={`rounded p-1 ${
            format.bold
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          onClick={() => applyFormat({ italic: !format.italic })}
          aria-label="Italic"
          aria-pressed={format.italic}
          className={`rounded p-1 ${
            format.italic
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Italic size={14} />
        </button>
        <button
          type="button"
          onClick={() => applyFormat({ underline: !format.underline })}
          aria-label="Underline"
          aria-pressed={format.underline}
          className={`rounded p-1 ${
            format.underline
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Underline size={14} />
        </button>
        <button
          type="button"
          onClick={() => applyFormat({ dim: !format.dim })}
          aria-label="Dim text"
          aria-pressed={format.dim}
          className={`rounded p-1 ${
            format.dim
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <EyeDashed size={14} />
        </button>
        <button
          type="button"
          onClick={() => applyTextTransform((s) => s.toUpperCase())}
          aria-label="Capitalize"
          title="Capitalize"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <CaseUpper size={14} />
        </button>
        <button
          type="button"
          onClick={() => applyTextTransform((s) => s.toLowerCase())}
          aria-label="Decapitalize"
          title="Decapitalize"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <CaseLower size={14} />
        </button>
        <DropdownMenu
          trigger={({ onClick, open }) => (
            <button
              type="button"
              onClick={onClick}
              aria-label="Text color"
              aria-pressed={open || !!format.color}
              className={`rounded p-1 ${
                format.color
                  ? 'bg-neutral-700 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
              }`}
              style={format.color ? { color: COLOR_PALETTE[format.color as keyof typeof COLOR_PALETTE] } : undefined}
            >
              <Baseline size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="grid w-max grid-cols-4 gap-1 p-1">
              {(Object.keys(COLOR_PALETTE) as (keyof typeof COLOR_PALETTE)[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    applyFormat({ color: format.color === key ? '' : key });
                    close();
                  }}
                  aria-label={key}
                  aria-pressed={format.color === key}
                  className={`h-6 w-6 rounded-full border ${
                    format.color === key ? 'border-neutral-100' : 'border-neutral-700'
                  }`}
                  style={{ backgroundColor: COLOR_PALETTE[key] }}
                />
              ))}
            </div>
          )}
        </DropdownMenu>
        <div className="w-px bg-neutral-700" />
        <button
          type="button"
          onClick={() => stepSize(-1)}
          aria-label="Smaller text"
          title="Smaller text"
          className="rounded px-1.5 text-xs leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
        <button
          type="button"
          onClick={() => stepSize(1)}
          aria-label="Bigger text"
          title="Bigger text"
          className="rounded px-1.5 text-lg leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
      </div>
      <input
        value={text}
        onChange={(e) => onChange(buildFormattedText(e.target.value, format))}
        placeholder={placeholder}
        className="w-full rounded-b-md bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-500"
      />
    </div>
  );
}
