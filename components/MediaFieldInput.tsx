'use client';

import { useState } from 'react';
import {
  Image as ImageIcon,
  AudioLines,
  Bold,
  Italic,
  Underline,
  EyeDashed,
  Baseline,
  ChevronDown,
  Type,
  ListChecks,
  type LucideIcon,
} from 'lucide-react';
import { type FieldType, type FieldTypeConfig, type TextFormat } from '@/lib/db';
import { sanitizeRichText, stripHtml } from '@/lib/sanitize';
import { shouldDropUp } from '@/lib/dropdownMenu';
import { COLOR_PALETTE } from '@/lib/richTextModel';
import { RichText } from './RichText';
import { TiptapFieldInput } from './TiptapFieldInput';
import { DropdownMenu } from './base/DropdownMenu';

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  richtext: 'Text',
  image: 'Image',
  audio: 'Audio',
  choice: 'Choice',
  richtext2: 'Text (Tiptap)',
};

const FIELD_TYPE_ICONS: Record<FieldType, LucideIcon> = {
  richtext: Type,
  image: ImageIcon,
  audio: AudioLines,
  choice: ListChecks,
  richtext2: Type,
};

// Only 'richtext' and 'choice' are offered when defining a NEW field —
// 'image'/'audio' (their own separate, single-item-only widgets) and
// 'dynamic'/'asset' (a per-note toggle between them) all rendered a
// narrower thing before TiptapFieldInput could hold any mix of text/
// images/audio in one field; there's nothing left to differentiate between
// for a new field now. A note type saved back when they were distinct
// still resolves exactly as before (see FieldValueInput's dispatch,
// lib/db.ts's FieldType doc comment) — this only narrows what's offered
// going forward, it doesn't touch already-declared fields.
const ALL_FIELD_TYPES: FieldType[] = ['richtext', 'choice'];

/** 2-way selector used in the note-type editor, declaring a field's fixed
 * type: rich content (text, images, audio, any mix) or a constrained pick
 * from a fixed option list declared on the note type. */
export function FieldTypeConfigToggle({
  value,
  onChange,
}: {
  value: FieldTypeConfig;
  onChange: (type: FieldTypeConfig) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]">
      {ALL_FIELD_TYPES.map((type) => {
        const Icon = FIELD_TYPE_ICONS[type];
        return (
          <button
            key={type}
            type="button"
            onClick={() => onChange(type)}
            aria-label={FIELD_TYPE_LABELS[type]}
            title={FIELD_TYPE_LABELS[type]}
            className={`flex h-[22px] w-[22px] items-center justify-center rounded ${
              value === type
                ? 'bg-neutral-700 text-neutral-100'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}

const SOLE_IMG_RE = /^<img\b[^>]*>$/i;
const SOLE_AUDIO_RE = /^<audio\b[^>]*>(?:<\/audio>)?$/i;

/** Infers a field's current type from its stored content — used for Basic's
 * Front/Back and "dynamic" custom fields, neither of which have a persisted
 * type to read instead. Anything that isn't exactly one bare `<img>`/`<audio>`
 * tag (e.g. real rich text, or empty) is treated as rich text. */
export function inferFieldType(html: string): FieldType {
  const trimmed = html.trim();
  if (SOLE_IMG_RE.test(trimmed)) return 'image';
  if (SOLE_AUDIO_RE.test(trimmed)) return 'audio';
  return 'richtext';
}

// Zero-width space — a caret-holding marker the old (now-removed)
// RichTextInput used to insert so an otherwise-empty formatting span still
// had a text node to anchor a collapsed caret in. Tiptap has no equivalent
// (its stored-marks mechanism, used by TiptapFieldInput's initialFormat
// seeding, never touches the DOM at all until real text is typed), but
// already-saved cards can still contain one from before this editor
// switched over. `.trim()` alone doesn't strip it (it isn't standard
// whitespace), so a field that was only ever auto-formatted but never
// actually typed into would otherwise misreport as "has content".
const ZERO_WIDTH_SPACE_RE = /\u200B/g;

/** A field "has content" if it has any non-whitespace text OR at least one
 * embedded image/audio — the two are no longer mutually exclusive (a field
 * can hold text with inline images/audio mixed in, see TiptapFieldInput),
 * so this can't just check one or the other by type the way it used to.
 * 'choice' is the only type where a field's value is still always exactly
 * one thing (the picked option's plain text), so it keeps its own
 * text-only check. */
export function fieldHasContent(html: string, type: FieldType): boolean {
  if (type === 'choice') {
    return !!stripHtml(html).replace(ZERO_WIDTH_SPACE_RE, '').trim();
  }
  if (!html.trim()) return false;
  const hasText = !!stripHtml(html).replace(ZERO_WIDTH_SPACE_RE, '').trim();
  return hasText || /<(img|audio)\b/i.test(html);
}

/** True when the field has an embedded image/audio missing its required
 * label — checked per element now, not once for the whole field, since a
 * field can hold more than one (see TiptapFieldInput's inline insertion).
 * A label is what makes an otherwise-untextual image/audio findable in
 * search (see lib/search.ts's extractSearchableText) — text elsewhere in
 * the same field doesn't excuse an unlabeled image from needing its own.
 * 'choice' has no label concept — the picked option text is already what's
 * searchable. */
export function fieldNeedsLabel(html: string, type: FieldType): boolean {
  if (type === 'choice' || typeof document === 'undefined') return false;
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.querySelectorAll('img, audio')).some((el) => {
    const label = el.tagName === 'IMG' ? el.getAttribute('alt') : el.getAttribute('title');
    return !label?.trim();
  });
}

/** Reconciles a note's stored field values against its note type's *current*
 * field list when opening it for editing — the note type can change after
 * notes of that type already exist (fields renamed or removed), and
 * there's no migration of already-saved note data when that happens.
 * Fields are keyed by their stable id (see NoteType's own doc comment), not
 * by display name, so renaming a field carries its value forward same as
 * any other edit — only actually *removing* a field discards anything:
 *  - a field id no longer in the note type (removed) is dropped entirely
 *    — its old value never carries forward;
 *  - a field id with no stored value yet (newly added) starts empty, same
 *    as any new field;
 *  - a choice field is cleared if its stored value is no longer one of the
 *    type's current options (renamed or removed since the note was saved).
 * Every other config (richtext, the legacy richtext2, and the legacy
 * image/audio/dynamic/asset — see lib/db.ts's FieldType doc comment) all
 * render the same unified content editor now, which accepts any mix of
 * text/image/audio, so there's no "wrong shape" left to guard against —
 * the stored value always carries forward as-is. */
export function reconcileFieldValues(
  storedFields: Record<string, string>,
  noteType: {
    fields: string[];
    fieldTypes: Record<string, FieldTypeConfig>;
    fieldChoices?: Record<string, string[]>;
  }
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const fieldId of noteType.fields) {
    const config = noteType.fieldTypes[fieldId] ?? 'richtext';
    const stored = storedFields[fieldId];
    if (stored === undefined) {
      result[fieldId] = '';
    } else if (config === 'choice') {
      const options = noteType.fieldChoices?.[fieldId] ?? [];
      result[fieldId] = options.includes(stripHtml(stored)) ? stored : '';
    } else {
      result[fieldId] = stored;
    }
  }
  return result;
}

const TEXT_MIN_SIZE = 1;
const TEXT_MAX_SIZE = 5;
const TEXT_NORMAL_SIZE = 3; // unwrapped — no <span data-size> at all

export const NORMAL_TEXT_FORMAT: TextFormat = {
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  color: '',
  size: TEXT_NORMAL_SIZE,
};

/** Reads which of the rich text toolbar's effects apply to an *entire* piece
 * of stored HTML — used wherever formatting is reasoned about as a whole-string
 * property rather than a partial/live selection (a choice field's picked
 * option, a note type's per-field starter template read back off its name).
 * A selection/string with only some of its text in a given effect (e.g. one
 * word bold out of a whole name) still reads as that effect being "on" —
 * the same whole-string simplification buildFormattedText below makes when
 * writing it back. */
export function readTextFormat(html: string): TextFormat {
  if (typeof document === 'undefined' || !html.trim()) return NORMAL_TEXT_FORMAT;
  const template = document.createElement('template');
  template.innerHTML = html;
  const sizeEl = template.content.querySelector('[data-size]');
  const size = sizeEl ? Number(sizeEl.getAttribute('data-size')) : TEXT_NORMAL_SIZE;
  const colorEl = template.content.querySelector('[data-color]');
  const color = colorEl?.getAttribute('data-color') ?? '';
  return {
    bold: !!template.content.querySelector('b'),
    italic: !!template.content.querySelector('i'),
    underline: !!template.content.querySelector('u'),
    dim: !!template.content.querySelector('[data-dim]'),
    color: color in COLOR_PALETTE ? color : '',
    size: Number.isFinite(size) ? size : TEXT_NORMAL_SIZE,
  };
}

/** Rebuilds a whole-string HTML value by wrapping plain text in the given
 * format, from the inside out — building via DOM APIs (not string
 * concatenation) so the text's own escaping is handled by the browser. */
export function buildFormattedText(text: string, format: TextFormat): string {
  if (!text) return '';
  let node: Node = document.createTextNode(text);
  function wrap(tag: string, attrs?: Record<string, string>) {
    const el = document.createElement(tag);
    if (attrs) for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, val);
    el.appendChild(node);
    node = el;
  }
  if (format.size !== TEXT_NORMAL_SIZE) wrap('span', { 'data-size': String(format.size) });
  if (format.color) wrap('span', { 'data-color': format.color });
  if (format.dim) wrap('span', { 'data-dim': '' });
  if (format.underline) wrap('u');
  if (format.italic) wrap('i');
  if (format.bold) wrap('b');
  const container = document.createElement('div');
  container.appendChild(node);
  return sanitizeRichText(container.innerHTML);
}

/** Dropdown for a 'choice' field, plus a toolbar of the same rich text
 * effects TiptapFieldInput offers (bold/italic/underline/dim/size) — but
 * applied to the whole picked option at once rather than a selection, since
 * a choice field's value is never partial text. Its option list is declared
 * once on the note type (see NoteType.fieldChoices), not per-note, so
 * options are always passed in rather than derived from `value`.
 * `templateFormat`, when given, is the format an as-yet-unpicked field
 * starts from (see NoteType.fieldTemplates) — once an option is actually
 * picked, the format read back off the stored value takes over. */
export function ChoiceFieldInput({
  value,
  onChange,
  options,
  templateFormat,
}: {
  value: string;
  onChange: (html: string) => void;
  options: string[];
  templateFormat?: TextFormat;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const selected = stripHtml(value);
  const hasSelection = !!selected && options.includes(selected);
  const format = hasSelection ? readTextFormat(value) : templateFormat ?? NORMAL_TEXT_FORMAT;

  function applyFormat(patch: Partial<TextFormat>) {
    onChange(buildFormattedText(selected, { ...format, ...patch }));
  }

  function stepSize(delta: number) {
    const next = Math.min(TEXT_MAX_SIZE, Math.max(TEXT_MIN_SIZE, format.size + delta));
    if (next !== format.size) applyFormat({ size: next });
  }

  function pickOption(option: string) {
    onChange(buildFormattedText(option, format));
    setOpen(false);
  }

  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex gap-1 border-b border-neutral-700 p-1">
        <button
          type="button"
          onClick={() => applyFormat({ bold: !format.bold })}
          disabled={!hasSelection}
          aria-label="Bold"
          aria-pressed={format.bold}
          className={`rounded p-1 disabled:opacity-40 ${
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
          disabled={!hasSelection}
          aria-label="Italic"
          aria-pressed={format.italic}
          className={`rounded p-1 disabled:opacity-40 ${
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
          disabled={!hasSelection}
          aria-label="Underline"
          aria-pressed={format.underline}
          className={`rounded p-1 disabled:opacity-40 ${
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
          disabled={!hasSelection}
          aria-label="Dim text"
          aria-pressed={format.dim}
          className={`rounded p-1 disabled:opacity-40 ${
            format.dim
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <EyeDashed size={14} />
        </button>
        <DropdownMenu
          trigger={({ onClick, open: colorOpen }) => (
            <button
              type="button"
              onClick={onClick}
              disabled={!hasSelection}
              aria-label="Text color"
              aria-pressed={colorOpen || !!format.color}
              className={`rounded p-1 disabled:opacity-40 ${
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
          disabled={!hasSelection}
          aria-label="Smaller text"
          title="Smaller text"
          className="rounded px-1.5 text-xs leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
        >
          A
        </button>
        <button
          type="button"
          onClick={() => stepSize(1)}
          disabled={!hasSelection}
          aria-label="Bigger text"
          title="Bigger text"
          className="rounded px-1.5 text-lg leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
        >
          A
        </button>
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            const opening = !open;
            setOpen(opening);
            if (opening) setDropUp(shouldDropUp(e.currentTarget));
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
        >
          {hasSelection ? (
            <RichText html={value} />
          ) : (
            <span className="text-neutral-500">Select…</span>
          )}
          <ChevronDown size={14} className="shrink-0 text-neutral-500" />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              role="listbox"
              className={`absolute inset-x-0 z-50 max-h-56 overflow-auto rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-lg ${
                dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
              }`}
            >
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={option === selected}
                  onClick={() => pickOption(option)}
                  className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-800 ${
                    option === selected ? 'text-neutral-100' : 'text-neutral-300'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Renders whichever widget matches a field's current type — shared by the
 * add-card modal and CardRow's edit mode so the dispatch logic only lives
 * in one place. `options` is only meaningful (and required to have any
 * choices) when `type === 'choice'`.
 *
 * Every type except 'choice' renders the same TiptapFieldInput now —
 * including the legacy 'image'/'audio'/'richtext2' (see lib/db.ts's
 * FieldType doc comment), which used to route to the standalone
 * ImageFieldInput/AudioFieldInput/old-RichTextInput widgets. Those widgets
 * only ever supported one image, one audio clip, or plain text
 * respectively; TiptapFieldInput supports any mix of all three in one
 * field, and the exact same stored HTML those old widgets produced is
 * already valid input to it, so nothing about existing notes/cards needed
 * to change for this — only which widget renders them. */
export function FieldValueInput({
  type,
  value,
  onChange,
  placeholder,
  options,
  templateFormat,
}: {
  type: FieldType;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  options?: string[];
  templateFormat?: TextFormat;
}) {
  if (type === 'choice') {
    return (
      <ChoiceFieldInput
        value={value}
        onChange={onChange}
        options={options ?? []}
        templateFormat={templateFormat}
      />
    );
  }
  return (
    <TiptapFieldInput value={value} onChange={onChange} placeholder={placeholder} initialFormat={templateFormat} />
  );
}
