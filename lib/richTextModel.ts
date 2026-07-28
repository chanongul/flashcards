// A small, explicit document model for RichTextInput, replacing DOM-as-
// source-of-truth editing (execCommand + ad hoc per-effect Range surgery)
// with one generic pipeline: parse the live DOM into this flat model
// (together with the current selection, as plain character offsets), apply
// a pure transform to the model, serialize back to HTML, write it, and
// restore the selection from the same offsets. Every formatting effect
// (bold/italic/underline/dim/size/color) and text transform (capitalize/
// decapitalize) goes through the functions below instead of its own
// selection-save/restore code — that duplication, with each copy handling
// collapsed-vs-expanded selections slightly differently, was the root cause
// of selection loss and one effect's pending state clobbering another's in
// the previous implementation.
//
// Functions here that never touch `document`/DOM types (everything except
// parseWithSelection/parseDocument/offsetsToRange) are pure data
// transforms, deliberately kept that way so they're trivially unit-testable
// without a browser.

export interface MarkSet {
  bold?: true;
  italic?: true;
  underline?: true;
  dim?: true; // opacity-based de-emphasis — a distinct axis from color, not a substitute for it
  size?: number; // MIN_SIZE..MAX_SIZE, never NORMAL_SIZE — absent means normal
  color?: string; // a key from COLOR_PALETTE; absent means default
}

export type EditorNode = { kind: 'text'; text: string; marks: MarkSet } | { kind: 'break' };

export const MIN_SIZE = 1;
export const MAX_SIZE = 5;
export const NORMAL_SIZE = 3;

// Fixed palette, not free-form color — same reasoning lib/sanitize.ts
// already applies to font size: arbitrary values are a needless risk/
// consistency problem for a feature that only needs a handful of options.
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

export function modelLength(nodes: EditorNode[]): number {
  return nodes.reduce((n, node) => n + (node.kind === 'text' ? node.text.length : 1), 0);
}

function markValueEqual(a: unknown, b: unknown): boolean {
  return (a ?? undefined) === (b ?? undefined);
}

function marksEqual(a: MarkSet, b: MarkSet): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.dim === !!b.dim &&
    markValueEqual(a.size, b.size) &&
    markValueEqual(a.color, b.color)
  );
}

// ---- Pure model transforms (no DOM) ----

function coalesce(nodes: EditorNode[]): EditorNode[] {
  const out: EditorNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.kind === 'text' && node.text === '') continue;
    if (node.kind === 'text' && prev?.kind === 'text' && marksEqual(prev.marks, node.marks)) {
      prev.text += node.text;
    } else {
      out.push(node.kind === 'text' ? { ...node } : node);
    }
  }
  return out;
}

function splitAt(nodes: EditorNode[], offset: number): EditorNode[] {
  const out: EditorNode[] = [];
  let pos = 0;
  for (const node of nodes) {
    const len = node.kind === 'text' ? node.text.length : 1;
    if (node.kind === 'text' && pos < offset && offset < pos + len) {
      const cut = offset - pos;
      out.push({ kind: 'text', text: node.text.slice(0, cut), marks: node.marks });
      out.push({ kind: 'text', text: node.text.slice(cut), marks: node.marks });
    } else {
      out.push(node);
    }
    pos += len;
  }
  return out;
}

function mapInRange(
  nodes: EditorNode[],
  start: number,
  end: number,
  fn: (node: Extract<EditorNode, { kind: 'text' }>) => EditorNode
): EditorNode[] {
  if (start === end) return nodes;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const split = splitAt(splitAt(nodes, lo), hi);
  let pos = 0;
  return split.map((node) => {
    const len = node.kind === 'text' ? node.text.length : 1;
    const withinRange = node.kind === 'text' && pos >= lo && pos + len <= hi;
    pos += len;
    return withinRange ? fn(node as Extract<EditorNode, { kind: 'text' }>) : node;
  });
}

/** Merges `patch` into every text node fully inside [start, end) — a value
 * of `undefined` or `false` clears that mark, anything else sets it. One
 * function for bold, italic, underline, dim, size, and color. No-op on a
 * collapsed selection (nothing to mark) — callers use the pending-marks
 * mechanism for that case instead. */
export function applyMark(
  nodes: EditorNode[],
  start: number,
  end: number,
  patch: Partial<Record<keyof MarkSet, MarkSet[keyof MarkSet] | false>>
): EditorNode[] {
  return mapInRange(nodes, start, end, (node) => {
    const marks: MarkSet = { ...node.marks };
    for (const key of Object.keys(patch) as (keyof MarkSet)[]) {
      const value = patch[key];
      if (value === undefined || value === false) delete marks[key];
      else (marks as Record<string, unknown>)[key] = value;
    }
    return { ...node, marks };
  });
}

/** Rewrites the text of every node fully inside [start, end) via `fn`,
 * leaving marks untouched. Powers capitalize/decapitalize. */
export function transformText(
  nodes: EditorNode[],
  start: number,
  end: number,
  fn: (s: string) => string
): EditorNode[] {
  return mapInRange(nodes, start, end, (node) => ({ ...node, text: fn(node.text) }));
}

/** Marks "active" across [start, end): a mark counts only if every
 * non-whitespace text node touching the range has the same value for it
 * (the same all-or-nothing rule the old isDimmed used, generalized to every
 * axis) — drives the toolbar's pressed/level state. For a collapsed
 * selection, falls back to the marks of the text immediately before the
 * caret (what typing there would inherit), matching how caret-position
 * formatting state is conventionally shown in text editors. */
export function getActiveMarks(nodes: EditorNode[], start: number, end: number): MarkSet {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);

  if (lo === hi) {
    let pos = 0;
    let before: MarkSet | null = null;
    let after: MarkSet | null = null;
    for (const node of nodes) {
      const len = node.kind === 'text' ? node.text.length : 1;
      if (node.kind === 'text' && pos + len <= lo) before = node.marks;
      if (node.kind === 'text' && after === null && pos >= lo) after = node.marks;
      pos += len;
    }
    return { ...(before ?? after ?? {}) };
  }

  let pos = 0;
  const matched: Extract<EditorNode, { kind: 'text' }>[] = [];
  for (const node of nodes) {
    const len = node.kind === 'text' ? node.text.length : 1;
    const overlaps = pos < hi && pos + len > lo;
    if (overlaps && node.kind === 'text' && node.text.trim().length > 0) matched.push(node);
    pos += len;
  }
  if (matched.length === 0) return {};

  const result: MarkSet = { ...matched[0].marks };
  for (const key of Object.keys(result) as (keyof MarkSet)[]) {
    if (!matched.every((n) => markValueEqual(n.marks[key], result[key]))) delete result[key];
  }
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Model -> HTML. Nesting order (innermost to outermost: size, color, dim,
 * underline, italic, bold) matches MediaFieldInput.tsx's buildFormattedText
 * convention of one wrapper per mark rather than combining attributes onto
 * a single span, so round-tripping already-stored content doesn't
 * gratuitously restructure it. */
export function serialize(nodes: EditorNode[]): string {
  return coalesce(nodes)
    .map((node) => {
      if (node.kind === 'break') return '<br>';
      if (node.text.length === 0) return '';
      let html = escapeHtml(node.text);
      const { marks } = node;
      if (marks.size && marks.size !== NORMAL_SIZE) html = `<span data-size="${marks.size}">${html}</span>`;
      if (marks.color) html = `<span data-color="${marks.color}">${html}</span>`;
      if (marks.dim) html = `<span data-dim>${html}</span>`;
      if (marks.underline) html = `<u>${html}</u>`;
      if (marks.italic) html = `<i>${html}</i>`;
      if (marks.bold) html = `<b>${html}</b>`;
      return html;
    })
    .join('');
}

// ---- DOM <-> model (the only functions here that touch document/Node) ----

function tagMark(tag: string): 'bold' | 'italic' | 'underline' | null {
  if (tag === 'B' || tag === 'STRONG') return 'bold';
  if (tag === 'I' || tag === 'EM') return 'italic';
  if (tag === 'U' || tag === 'INS') return 'underline';
  return null;
}

interface WalkState {
  nodes: EditorNode[];
  pos: number;
  start: number | null;
  end: number | null;
}

function checkBoundary(state: WalkState, container: Node, offset: number, range: Range | null) {
  if (!range) return;
  if (state.start === null && range.startContainer === container && range.startOffset === offset) {
    state.start = state.pos;
  }
  if (state.end === null && range.endContainer === container && range.endOffset === offset) {
    state.end = state.pos;
  }
}

function walk(node: Node, marks: MarkSet, state: WalkState, range: Range | null) {
  const children = Array.from(node.childNodes);
  for (let i = 0; i < children.length; i++) {
    checkBoundary(state, node, i, range);
    const child = children[i];

    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child as Text).data;
      if (range) {
        if (state.start === null && child === range.startContainer) state.start = state.pos + range.startOffset;
        if (state.end === null && child === range.endContainer) state.end = state.pos + range.endOffset;
      }
      if (text.length > 0) state.nodes.push({ kind: 'text', text, marks });
      state.pos += text.length;
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName;

    if (tag === 'BR') {
      state.nodes.push({ kind: 'break' });
      state.pos += 1;
      continue;
    }

    if (tag === 'IMG' || tag === 'AUDIO') {
      // Not a supported inline element for this editor — images/audio are
      // their own field type (MediaFieldInput), never typed or pasted into
      // a richtext field in normal use. Drop rather than half-support
      // round-tripping it.
      continue;
    }

    const mark = tagMark(tag);
    if (mark) {
      walk(child, { ...marks, [mark]: true }, state, range);
      checkBoundary(state, node, i + 1, range);
      continue;
    }

    if (tag === 'SPAN') {
      const size = el.getAttribute('data-size');
      const color = el.getAttribute('data-color');
      const nextMarks: MarkSet = { ...marks };
      const sizeNum = size ? Number(size) : NaN;
      if (Number.isFinite(sizeNum) && sizeNum >= MIN_SIZE && sizeNum <= MAX_SIZE) nextMarks.size = sizeNum;
      if (color && color in COLOR_PALETTE) nextMarks.color = color;
      if (el.hasAttribute('data-dim')) nextMarks.dim = true;
      walk(child, nextMarks, state, range);
      checkBoundary(state, node, i + 1, range);
      continue;
    }

    // Unrecognized wrapper (a stray tag, a paste artifact) — transparent:
    // descend into its children contributing no mark, rather than dropping
    // the text.
    walk(child, marks, state, range);
    checkBoundary(state, node, i + 1, range);
  }
  checkBoundary(state, node, children.length, range);
}

/** Parses the live DOM under `root` into the flat model, without any
 * selection concern — used for formatEntireValue (the whole field is
 * always the "selection") and anywhere else the current content is needed
 * without a live Range. */
export function parseDocument(root: HTMLElement): EditorNode[] {
  const state: WalkState = { nodes: [], pos: 0, start: null, end: null };
  walk(root, {}, state, null);
  return state.nodes;
}

/** Parses `root` into the flat model AND locates `range`'s start/end as
 * character offsets into that same flat sequence, in one pass — the single
 * source of truth that keeps "where the model says the selection is" from
 * ever disagreeing with "where the DOM says it is". */
export function parseWithSelection(
  root: HTMLElement,
  range: Range
): { nodes: EditorNode[]; start: number; end: number } {
  const state: WalkState = { nodes: [], pos: 0, start: null, end: null };
  walk(root, {}, state, range);
  return { nodes: state.nodes, start: state.start ?? state.pos, end: state.end ?? state.pos };
}

function findDomPosition(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  let pos = 0;
  let lastText: Text | null = null;

  function visit(node: Node): { node: Node; offset: number } | null {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child as Text;
        const len = text.data.length;
        if (target <= pos + len) return { node: text, offset: target - pos };
        pos += len;
        lastText = text;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = (child as HTMLElement).tagName;
      if (tag === 'IMG' || tag === 'AUDIO') continue;
      if (tag === 'BR') {
        if (target === pos) {
          const parent = child.parentNode!;
          return { node: parent, offset: Array.from(parent.childNodes).indexOf(child as ChildNode) };
        }
        pos += 1;
        continue;
      }
      const found = visit(child);
      if (found) return found;
    }
    return null;
  }

  const found = visit(root);
  if (found) return found;
  if (lastText) return { node: lastText, offset: (lastText as Text).data.length };
  return { node: root, offset: root.childNodes.length };
}

/** Inverse of the selection half of parseWithSelection — walks the DOM
 * (called right after a fresh innerHTML write, so it's walking the newly-
 * serialized content) to build a Range at the given model offsets, for
 * restoring the selection after a formatting operation. */
export function offsetsToRange(root: HTMLElement, start: number, end: number): Range | null {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const startPos = findDomPosition(root, lo);
  const endPos = findDomPosition(root, hi);
  if (!startPos || !endPos) return null;
  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  return range;
}
