// Rich text formatting constants shared by every field-formatting UI:
// TiptapFieldInput's live toolbar, TemplateFormatInput's whole-string
// toolbar, and ChoiceFieldInput's own. Kept in one place so all three read
// from (and produce output for) exactly the same size scale and color
// palette. This file used to also hold RichTextInput's whole hand-rolled
// document model (parse/serialize/applyMark/etc.) — removed once
// TiptapFieldInput replaced it and nothing needed those functions anymore.

export const MIN_SIZE = 1;
export const MAX_SIZE = 5;
export const NORMAL_SIZE = 3;

// Fixed palette, not free-form color — same reasoning lib/sanitize.ts
// already applies to font size: arbitrary values are a needless risk/
// consistency problem for a feature that only needs a handful of options.
// Image display width, as a percent of the field's own width — dragged via
// the resize handle on a selected image (see TiptapFieldInput's
// ImageNodeView). No MAX below 100 (full natural size, the pre-resize
// default) and a floor so a slip of the pointer can't shrink an image to
// nothing.
export const MIN_IMAGE_WIDTH_PERCENT = 15;
export const MAX_IMAGE_WIDTH_PERCENT = 100;

// MIN_IMAGE_WIDTH_PERCENT alone isn't enough of a floor for a landscape/
// panoramic image — 15% of a narrow field can still work out to a sliver
// only a few px tall once the aspect ratio is applied. This is a floor on
// the RENDERED height in px (not a percent — there's no natural "100%" for
// height the way there is for width), which ImageNodeView's drag enforces
// by raising the effective width floor for that specific image whenever
// its own aspect ratio would otherwise let it get shorter than this.
export const MIN_IMAGE_HEIGHT_PX = 40;

// Audio's own width, as a percent of the field — dragged via the resize
// handle on a selected audio node (see TiptapFieldInput's AudioNodeView).
// Unlike an image, audio has no meaningful "natural" size to shrink-wrap
// to (a native <audio controls> player's default width is just arbitrary
// UA chrome, not tied to the audio's own content) — the field already
// forces it to 100% by default (see globals.css's `.rich-text-content
// audio` rule), so MAX here is that same default, not a "no limit" cap.
// MIN is higher than an image's own floor — narrower than this and
// Chrome's native controls start hiding pieces of themselves (usually the
// volume control first), which reads as broken rather than compact.
export const MIN_AUDIO_WIDTH_PERCENT = 40;
export const MAX_AUDIO_WIDTH_PERCENT = 100;

export const COLOR_PALETTE = {
  white: '#ffffff',
  black: '#000000',
  red: '#f87171',
  orange: '#fb923c',
  yellow: '#facc15',
  green: '#4ade80',
  blue: '#60a5fa',
  purple: '#c084fc',
} as const;
export type ColorKey = keyof typeof COLOR_PALETTE;

// Paragraph/blockquote text alignment — a fixed set, not free-form CSS, same
// reasoning as every other axis above. Lives here (not
// lib/tiptapBlockExtensions.ts, where the actual BlockAlign extension is
// defined) specifically so lib/sanitize.ts can import just this small
// dependency-free constant to validate `data-align` without pulling in that
// file's own dependency graph (Tiptap's table/list/code-block extensions,
// lowlight, highlight.js's language grammars) — sanitize.ts runs on every
// card render/sync and has no other reason to carry any of that.
export const ALIGN_VALUES = ['left', 'center', 'right', 'justify'] as const;
export type AlignValue = (typeof ALIGN_VALUES)[number];

// Code block language picker — the toolbar's <select> and the actual
// lowlight registration in lib/tiptapBlockExtensions.ts both read this same
// list (so what's offered and what's actually highlightable can't drift
// apart), and lib/sanitize.ts validates a stored `language-*` class against
// it for the same "closed set, not open-ended" reasoning as everything else
// here. Key is what's stored/registered with lowlight (matches
// highlight.js's own language ids); label is what the picker shows.
export const CODE_BLOCK_LANGUAGES = [
  { key: 'plaintext', label: 'Plain text' },
  { key: 'javascript', label: 'JavaScript' },
  { key: 'typescript', label: 'TypeScript' },
  { key: 'python', label: 'Python' },
  { key: 'java', label: 'Java' },
  { key: 'c', label: 'C' },
  { key: 'cpp', label: 'C++' },
  { key: 'csharp', label: 'C#' },
  { key: 'go', label: 'Go' },
  { key: 'rust', label: 'Rust' },
  { key: 'ruby', label: 'Ruby' },
  { key: 'php', label: 'PHP' },
  { key: 'xml', label: 'HTML/XML' },
  { key: 'css', label: 'CSS' },
  { key: 'json', label: 'JSON' },
  { key: 'bash', label: 'Bash' },
  { key: 'sql', label: 'SQL' },
  { key: 'yaml', label: 'YAML' },
] as const;
export type CodeBlockLanguage = (typeof CODE_BLOCK_LANGUAGES)[number]['key'];
