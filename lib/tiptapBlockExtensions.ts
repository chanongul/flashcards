// Block-level schema additions (blockquote/lists/code block/horizontal
// rule/table/math) — split out from lib/tiptapExtensions.ts (which now
// holds only the original inline-content extensions: marks, media, and
// HardBreak) purely because this file got large; there's no other reason
// for the split. See BlockDoc's own doc comment for why these needed a
// bigger schema change than just "add a new node type" — every one of them
// is fundamentally a block-level construct, which the old doc schema
// (content: 'inline*', no paragraph node at all) couldn't hold at any level
// of nesting.
import { Node, Extension, mergeAttributes } from '@tiptap/core';
import { keymap } from '@tiptap/pm/keymap';
import { baseKeymap } from '@tiptap/pm/commands';
import { gapCursor } from '@tiptap/pm/gapcursor';
import { Paragraph as BaseParagraph } from '@tiptap/extension-paragraph';
import { Blockquote as BaseBlockquote } from '@tiptap/extension-blockquote';
import { BulletList as BaseBulletList, OrderedList as BaseOrderedList, ListItem as BaseListItem, ListKeymap } from '@tiptap/extension-list';
import { HorizontalRule as BaseHorizontalRule } from '@tiptap/extension-horizontal-rule';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Table as BaseTable, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { createLowlight } from 'lowlight';
import { ALIGN_VALUES, type AlignValue, CODE_BLOCK_LANGUAGES } from './richTextModel';
import jsLang from 'highlight.js/lib/languages/javascript';
import tsLang from 'highlight.js/lib/languages/typescript';
import pyLang from 'highlight.js/lib/languages/python';
import javaLang from 'highlight.js/lib/languages/java';
import cLang from 'highlight.js/lib/languages/c';
import cppLang from 'highlight.js/lib/languages/cpp';
import csharpLang from 'highlight.js/lib/languages/csharp';
import goLang from 'highlight.js/lib/languages/go';
import rustLang from 'highlight.js/lib/languages/rust';
import rubyLang from 'highlight.js/lib/languages/ruby';
import phpLang from 'highlight.js/lib/languages/php';
import htmlLang from 'highlight.js/lib/languages/xml';
import cssLang from 'highlight.js/lib/languages/css';
import jsonLang from 'highlight.js/lib/languages/json';
import bashLang from 'highlight.js/lib/languages/bash';
import sqlLang from 'highlight.js/lib/languages/sql';
import yamlLang from 'highlight.js/lib/languages/yaml';
import plaintextLang from 'highlight.js/lib/languages/plaintext';

// Every language key in richTextModel.ts's own CODE_BLOCK_LANGUAGES (what
// the toolbar's picker offers, and what lib/sanitize.ts validates a stored
// `language-*` class against) needs a matching registration here —
// registered individually (rather than lowlight's own bundled "common"
// preset, which pulls in ~35 languages, most never offered in the picker)
// so the bundle only pays for what's actually selectable. Kept in sync by
// hand (same key strings on both sides); adding a language means adding it
// in both places. RichText.tsx's own read-only re-highlight effect imports
// this same `lowlight` instance, so it can only ever highlight what the
// editor itself could have produced.
export const lowlight = createLowlight();
lowlight.register({
  javascript: jsLang,
  typescript: tsLang,
  python: pyLang,
  java: javaLang,
  c: cLang,
  cpp: cppLang,
  csharp: csharpLang,
  go: goLang,
  rust: rustLang,
  ruby: rubyLang,
  php: phpLang,
  xml: htmlLang,
  css: cssLang,
  json: jsonLang,
  bash: bashLang,
  sql: sqlLang,
  yaml: yamlLang,
  plaintext: plaintextLang,
});

// The old top node (content: 'inline*', no paragraph/block node at all —
// see git history) made a second block structurally impossible, which was
// exactly right for a compact single-field editor with only text/marks/
// inline media. None of blockquote/list/code block/horizontal rule/table
// can exist under that schema at any level — every one of them is a block-
// level construct (ProseMirror content expressions are either block+ or
// inline*, never a mix at the same level), so supporting any of them meant
// switching the doc to hold real block children, with Paragraph as the
// base one text ends up in.
//
// Already-stored content (a flat inline sequence, no <p> wrapper at all)
// still parses correctly under this — ProseMirror's own DOMParser, when it
// finds inline content that doesn't fit directly in a block+ context, wraps
// it in whatever block type its schema search finds first that both accepts
// inline content and can legally sit in that context: Paragraph, the first
// (and, for existing content, only) node satisfying that. Confirmed via
// Playwright (see the verification pass this feature's own commit ran) —
// no migration step needed for any already-saved card.
export const BlockDoc = Node.create({
  name: 'doc',
  topNode: true,
  content: 'block+',
});

export const Paragraph = BaseParagraph;

// Adds a fixed-set `align` attribute (left/center/right/justify) to
// paragraph and blockquote — deliberately not `@tiptap/extension-text-align`
// as-is, whose default renderHTML writes an inline `style="text-align: X"`.
// Every other formatting axis in this schema (size, color, dim) renders as
// a `data-*` attribute instead of raw style specifically so lib/sanitize.ts
// can validate a fixed value rather than parse/allowlist arbitrary CSS —
// same reasoning applies here, so this reimplements just the attribute
// (not the whole extension) to match.
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockAlign: {
      // Applies to whichever of paragraph/blockquote is active at the
      // selection — same shape as @tiptap/extension-text-align's own
      // command, which this mirrors (updateAttributes on every configured
      // type harmlessly no-ops for whichever one isn't actually active).
      setAlign: (align: AlignValue) => ReturnType;
      unsetAlign: () => ReturnType;
    };
  }
}

export const BlockAlign = Extension.create({
  name: 'blockAlign',
  addOptions() {
    return { types: ['paragraph', 'blockquote'] as string[] };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          align: {
            default: null as AlignValue | null,
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute('data-align');
              return (ALIGN_VALUES as readonly string[]).includes(raw ?? '') ? raw : null;
            },
            renderHTML: (attrs: { align?: AlignValue | null }) =>
              attrs.align ? { 'data-align': attrs.align } : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setAlign:
        (align: AlignValue) =>
        ({ commands }) =>
          this.options.types.map((type: string) => commands.updateAttributes(type, { align })).some((ok: boolean) => ok),
      unsetAlign:
        () =>
        ({ commands }) =>
          this.options.types.map((type: string) => commands.resetAttributes(type, 'align')).some((ok: boolean) => ok),
    };
  },
});

export const Blockquote = BaseBlockquote;

// `type` (a/A/i/I roman-vs-alpha-vs-decimal numbering) dropped entirely —
// same "fixed, small surface" reasoning as skipping free-form CSS elsewhere
// in this schema; decimal numbering (the default) covers what a flashcard
// field actually needs, and every other formatting axis here is already a
// closed set rather than open-ended. `start` (resuming a list at a number
// other than 1) is kept — genuinely useful, and just a plain clamped
// integer, no new sanitizer surface.
export const OrderedList = BaseOrderedList.extend({
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (el: HTMLElement) => (el.hasAttribute('start') ? parseInt(el.getAttribute('start') || '1', 10) : 1),
      },
    };
  },
});
export const BulletList = BaseBulletList;
export const ListItem = BaseListItem;
export { ListKeymap };

export const HorizontalRule = BaseHorizontalRule;

// languageClassPrefix matches lib/sanitize.ts's own validation of `code`'s
// class attribute. Highlighting itself (the `hljs-*` token spans) is a
// ProseMirror *decoration* — ProseMirror-internal, painted live over the
// node's text but never part of the serialized document — so it never ends
// up in getHTML()'s output at all; only the plain text + the language class
// are real stored content. RichText.tsx's own read-only display re-derives
// the same decorations from the same `lowlight` instance at render time
// (see its own doc comment) — that's not a workaround, it's the only way
// highlighting can ever show up outside a live Tiptap editor.
export const CodeBlock = CodeBlockLowlight.configure({
  lowlight,
  languageClassPrefix: 'language-',
});

// resizable: false — the default `true` renders a per-column <colgroup>
// with inline pixel-width styles (drag-to-resize columns), which would mean
// allowlisting arbitrary numeric inline styles in lib/sanitize.ts purely for
// a feature this app doesn't expose a drag handle for anyway. Plain
// <table><tr><td> with no width styling at all, matching every other
// formatting axis in this schema's "fixed/simple over open-ended" bias.
export const Table = BaseTable.configure({ resizable: false });
export { TableRow, TableCell, TableHeader };

// LaTeX — two atomic nodes rather than one, since ProseMirror content
// expressions are either inline or block, never conditionally either
// (the same reason blockquote/lists/code block/table needed a real block
// schema in the first place — see BlockDoc's own doc comment). MathInline
// sits inline in a sentence like an equation reference; MathBlock is its
// own centered line, for a full displayed equation. Both store only the
// raw LaTeX *source* as the `latex` attribute — never the rendered output —
// same "never bake a computed representation into stored content" rule
// crop/trim/code-highlighting all follow elsewhere in this schema; actually
// typesetting it is entirely TiptapFieldInput's MathNodeView (editor) and
// RichText.tsx's own render effect (read-only display) doing it live via
// KaTeX, both reading from the same source string.
// Only needed for editing an *existing* math node — MathNodeView is a
// module-scoped component shared by every editor instance, so a click on a
// specific node needs a way back into this specific TiptapFieldInput
// instance's modal state (exact same reasoning as MediaImage/MediaAudio's
// own openEditor bridges). Inserting a *new* one needs no bridge at all —
// the toolbar's own "Insert math" button already lives in the same
// top-level component that owns the modal state, no NodeView boundary to
// cross.
//
// onSave/onDelete are closures the NodeView builds from its own getPos()/
// updateAttributes/editor — not a raw document position for the top-level
// component to act on independently, which would go stale if anything else
// edited the document while the modal was open. Mirrors ImageNodeView's own
// deleteImage (setNodeSelection then deleteSelection) for onDelete.
export interface MathBridge {
  openEditor:
    | ((
        current: { latex: string; display: boolean },
        onSave: (latex: string, display: boolean) => void,
        onDelete: () => void
      ) => void)
    | null;
}
declare module '@tiptap/core' {
  interface Storage {
    math: MathBridge;
  }
}
const mathAttributes = {
  latex: {
    default: '',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-latex') ?? '',
    renderHTML: (attrs: { latex?: string }) => ({ 'data-latex': attrs.latex ?? '' }),
  },
};
// A Tiptap extension's storage always lives at `editor.storage.<its own
// name>` — there's no way to point two different node types (MathInline,
// MathBlock) at one shared bucket by just declaring it on one of them, so
// this is a third, otherwise-inert Extension whose only job is holding it,
// named `math` to match the Storage interface augmentation above.
// MathNodeView (TiptapFieldInput.tsx), whichever of the two node types it's
// actually rendering, always reaches back into this same
// `editor.storage.math` bridge.
export const MathBridgeExtension = Extension.create({
  name: 'math',
  addStorage: (): MathBridge => ({ openEditor: null }),
});
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: false,
  addAttributes: () => mathAttributes,
  parseHTML: () => [{ tag: 'span[data-latex]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { contenteditable: 'false' })],
});
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  draggable: false,
  addAttributes: () => mathAttributes,
  parseHTML: () => [{ tag: 'div[data-latex]' }],
  renderHTML: ({ HTMLAttributes }) =>
    ['div', mergeAttributes(HTMLAttributes, { 'data-display': 'block', contenteditable: 'false' })],
});

// StarterKit normally wires both of these in; this schema never included
// StarterKit (it hand-picks every extension — see lib/tiptapExtensions.ts's
// own top comment), so with real block structure now in play they need
// adding explicitly:
//  - baseKeymap (prosemirror-commands) is what makes plain Enter split the
//    current block into a new one, Backspace join/delete across block
//    boundaries, etc. — completely absent before, since there was no block
//    to split (the old HardBreak override bound plain Enter to a line break
//    specifically because of that; see lib/tiptapExtensions.ts's HardBreak,
//    now reverted to the base extension's own Shift/Mod-Enter-only default
//    now that plain Enter has somewhere useful to go instead).
//  - gapCursor lets the caret land in a position with no adjacent text to
//    click into — e.g. immediately before/after a horizontal rule or table
//    at the start/end of the doc — the exact class of "can't place the
//    cursor there" bug already fixed once this session for images
//    (AudioNodeView/ImageNodeView's inline-vs-block wrapper bug), here at
//    the block level instead.
export const BlockEssentials = Extension.create({
  name: 'blockEssentials',
  addProseMirrorPlugins() {
    return [keymap(baseKeymap), gapCursor()];
  },
});
