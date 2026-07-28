'use client';

import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline, EyeDashed, CaseUpper, CaseLower, Baseline, Undo2, Redo2 } from 'lucide-react';
import { sanitizeRichText } from '@/lib/sanitize';
import type { TextFormat } from '@/lib/db';
import {
  type EditorNode,
  type MarkSet,
  parseDocument,
  parseWithSelection,
  offsetsToRange,
  applyMark,
  transformText,
  getActiveMarks,
  serialize,
  modelLength,
  MIN_SIZE,
  MAX_SIZE,
  NORMAL_SIZE,
  COLOR_PALETTE,
} from '@/lib/richTextModel';
import { DropdownMenu } from './base/DropdownMenu';

interface RichTextInputProps {
  value: string; // sanitized HTML
  onChange: (html: string) => void;
  placeholder?: string;
  // Format a brand-new, still-empty field should start typing in (see
  // NoteType.fieldTemplates) — applied once, the first time this field is
  // focused while still empty. Never touches non-empty content.
  initialFormat?: TextFormat;
  // When set, every toolbar click formats the field's entire content
  // instead of just the current selection — for a use case like a note
  // type's field-name template (see app/page.tsx), where the value is
  // always reasoned about as one whole-string template rather than
  // partially-styled text, so requiring a manual select-all first would
  // just be friction.
  formatEntireValue?: boolean;
}

// A zero-width space so a freshly-inserted, still-empty marker span has a
// text node to hold the caret in (an empty <span></span> can't reliably
// keep focus/caret position across browsers).
const ZWSP = '​';
const HISTORY_LIMIT = 50;
const TYPING_DEBOUNCE_MS = 500;

interface HistoryEntry {
  html: string;
  start: number;
  end: number;
}

export function RichTextInput({
  value,
  onChange,
  placeholder,
  initialFormat,
  formatEntireValue,
}: RichTextInputProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<MarkSet>({});
  const seededTemplateRef = useRef(false);

  // Pending marks for a collapsed-caret "typing state" — one marker span,
  // one pair of refs, shared by every effect (bold/italic/underline/size/
  // color) instead of the old per-effect trackers (a ref just for dim, an
  // untracked ad hoc insertion for size, native execCommand state for
  // bold/italic/underline) that could clobber each other.
  const pendingMarksRef = useRef<MarkSet | null>(null);
  const pendingSpanRef = useRef<HTMLElement | null>(null);

  const pastRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);
  const [, forceHistoryRender] = useState(0);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingBaselineRef = useRef<HistoryEntry | null>(null);
  const lastSnapshotRef = useRef<HistoryEntry>({ html: value, start: 0, end: 0 });

  // Sync external value changes (e.g. switching which card is open) — but
  // never while this field has focus. Echoing the value back through the DOM
  // while actively editing destroys the live cursor/selection (contentEditable
  // has no notion of "just update the diff" like a controlled <input> does;
  // setting .innerHTML tears down and recreates every node).
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value;
      lastSnapshotRef.current = { html: value, start: 0, end: 0 };
      pastRef.current = [];
      futureRef.current = [];
      pendingMarksRef.current = null;
      pendingSpanRef.current = null;
    }
  }, [value]);

  function snapshot(): HistoryEntry | null {
    const el = ref.current;
    if (!el) return null;
    const sel = window.getSelection();
    let start = 0;
    let end = 0;
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
      const r = parseWithSelection(el, sel.getRangeAt(0));
      start = r.start;
      end = r.end;
    }
    return { html: el.innerHTML, start, end };
  }

  function pushHistory(entry: HistoryEntry) {
    const past = pastRef.current;
    if (past.length > 0 && past[past.length - 1].html === entry.html) return;
    past.push(entry);
    if (past.length > HISTORY_LIMIT) past.shift();
    futureRef.current = [];
    forceHistoryRender((t) => t + 1);
  }

  function flushTypingBurst() {
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    const baseline = typingBaselineRef.current;
    typingBaselineRef.current = null;
    if (baseline) pushHistory(baseline);
  }

  // Called after every discrete toolbar operation (mark apply, text
  // transform) — these are deliberate actions and each gets its own undo
  // step. Flushes any in-progress debounced typing burst first, so a
  // "type -> format -> type" sequence undoes as three separate steps in
  // the right order instead of a merged mess.
  function commitOperation(before: HistoryEntry) {
    flushTypingBurst();
    pushHistory(before);
    lastSnapshotRef.current = snapshot() ?? before;
  }

  function updateActiveStates() {
    const el = ref.current;
    if (!el || document.activeElement !== el) return;
    if (pendingMarksRef.current) {
      setActive(pendingMarksRef.current);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
    if (formatEntireValue) {
      const nodes = parseDocument(el);
      setActive(getActiveMarks(nodes, 0, modelLength(nodes)));
      return;
    }
    const { nodes, start, end } = parseWithSelection(el, sel.getRangeAt(0));
    setActive(getActiveMarks(nodes, start, end));
  }

  useEffect(() => {
    document.addEventListener('selectionchange', updateActiveStates);
    return () => document.removeEventListener('selectionchange', updateActiveStates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Resolves the current model + selection offsets (or, in formatEntireValue
   * mode, the whole field regardless of the actual DOM selection) and hands
   * them to `fn`. The one entry point every toolbar action goes through. */
  function withSelection<T>(
    fn: (el: HTMLDivElement, nodes: EditorNode[], start: number, end: number) => T
  ): T | undefined {
    const el = ref.current;
    if (!el) return undefined;
    if (formatEntireValue) {
      const nodes = parseDocument(el);
      return fn(el, nodes, 0, modelLength(nodes));
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return undefined;
    const { nodes, start, end } = parseWithSelection(el, sel.getRangeAt(0));
    return fn(el, nodes, start, end);
  }

  function commitAndRestore(el: HTMLDivElement, nodes: EditorNode[], start: number, end: number) {
    const before = snapshot();
    const html = serialize(nodes);
    el.innerHTML = html;
    if (document.activeElement !== el) el.focus();
    const range = offsetsToRange(el, start, end);
    const sel = window.getSelection();
    if (range && sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    onChange(sanitizeRichText(html));
    if (before) commitOperation(before);
    setActive(getActiveMarks(nodes, start, end));
  }

  // ---- Collapsed-selection ("typing state") marker, shared by every mark ----

  function buildMarkerElement(marks: MarkSet): { root: Node; textNode: Text } {
    const textNode = document.createTextNode(ZWSP);
    let current: Node = textNode;
    function wrap(tag: string, attrs?: Record<string, string>) {
      const el = document.createElement(tag);
      if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      el.appendChild(current);
      current = el;
    }
    // Same innermost-to-outermost order as serialize(): size, color, dim,
    // underline, italic, bold.
    if (marks.size && marks.size !== NORMAL_SIZE) wrap('span', { 'data-size': String(marks.size) });
    if (marks.color) wrap('span', { 'data-color': marks.color });
    if (marks.dim) wrap('span', { 'data-dim': '' });
    if (marks.underline) wrap('u');
    if (marks.italic) wrap('i');
    if (marks.bold) wrap('b');
    return { root: current, textNode };
  }

  // Replaces the pending marker (if any) with a bare ZWSP text node and
  // parks the caret right after it — the marker's whole content is always
  // just the ZWSP (nothing was ever typed into it, or it wouldn't still be
  // "pending"), so this is length-preserving and never disturbs any real
  // content elsewhere in the field.
  function removePendingMarker() {
    const span = pendingSpanRef.current;
    pendingSpanRef.current = null;
    if (!span || !span.parentNode) return;
    const parent = span.parentNode;
    const marker = document.createTextNode(ZWSP);
    parent.replaceChild(marker, span);
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(marker, 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function renderPendingMarker(el: HTMLDivElement, caretPos: number, marks: MarkSet) {
    removePendingMarker();
    const range = offsetsToRange(el, caretPos, caretPos);
    const sel = window.getSelection();
    if (!range || !sel) return;

    const { root, textNode } = buildMarkerElement(marks);
    range.insertNode(root);
    pendingSpanRef.current = root as HTMLElement;

    const newRange = document.createRange();
    newRange.setStart(textNode, 1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);

    if (document.activeElement !== el) el.focus();
    onChange(sanitizeRichText(el.innerHTML));
    setActive(marks);
  }

  function togglePendingMark(
    el: HTMLDivElement,
    caretPos: number,
    nodes: EditorNode[],
    patch: Partial<Record<keyof MarkSet, MarkSet[keyof MarkSet] | false>>
  ) {
    const base = pendingMarksRef.current ?? getActiveMarks(nodes, caretPos, caretPos);
    const next: MarkSet = { ...base };
    for (const key of Object.keys(patch) as (keyof MarkSet)[]) {
      const v = patch[key];
      if (v === undefined || v === false) delete next[key];
      else (next as Record<string, unknown>)[key] = v;
    }
    if (Object.keys(next).length === 0) {
      pendingMarksRef.current = null;
      removePendingMarker();
      setActive({});
      return;
    }
    pendingMarksRef.current = next;
    renderPendingMarker(el, caretPos, next);
  }

  // ---- Toolbar actions — every one goes through withSelection + either
  // applyMark/transformText (real selection) or togglePendingMark
  // (collapsed caret) ----

  function toggleMark(key: 'bold' | 'italic' | 'underline' | 'dim') {
    withSelection((el, nodes, start, end) => {
      const current = start === end ? pendingMarksRef.current ?? getActiveMarks(nodes, start, end) : getActiveMarks(nodes, start, end);
      const patch = { [key]: !current[key] };
      if (start === end) {
        togglePendingMark(el, start, nodes, patch);
        return;
      }
      const newNodes = applyMark(nodes, start, end, patch);
      commitAndRestore(el, newNodes, start, end);
    });
  }

  function stepSize(delta: number) {
    withSelection((el, nodes, start, end) => {
      const current = start === end ? pendingMarksRef.current ?? getActiveMarks(nodes, start, end) : getActiveMarks(nodes, start, end);
      const currentSize = current.size ?? NORMAL_SIZE;
      const next = Math.min(MAX_SIZE, Math.max(MIN_SIZE, currentSize + delta));
      if (next === currentSize) return;
      const patch = { size: next === NORMAL_SIZE ? (false as const) : next };
      if (start === end) {
        togglePendingMark(el, start, nodes, patch);
        return;
      }
      const newNodes = applyMark(nodes, start, end, patch);
      commitAndRestore(el, newNodes, start, end);
    });
  }

  function setColor(color: string | null) {
    withSelection((el, nodes, start, end) => {
      const patch = { color: color ?? (false as const) };
      if (start === end) {
        togglePendingMark(el, start, nodes, patch);
        return;
      }
      const newNodes = applyMark(nodes, start, end, patch);
      commitAndRestore(el, newNodes, start, end);
    });
  }

  function applyTextTransform(fn: (s: string) => string) {
    withSelection((el, nodes, start, end) => {
      // No sensible "typing state" equivalent for a text transform — there's
      // no future text yet to transform, so this is a no-op without a real
      // (non-collapsed) selection, matching bold/italic's own native
      // behavior of needing an actual selection to act on.
      if (start === end) return;
      const newNodes = transformText(nodes, start, end, fn);
      commitAndRestore(el, newNodes, start, end);
    });
  }

  // ---- Natural typing: let the browser edit the DOM directly, just read
  // it back out and feed the debounced undo-snapshot mechanism ----

  function handleInput() {
    const el = ref.current;
    if (!el) return;

    if (pendingSpanRef.current && pendingSpanRef.current.textContent !== ZWSP) {
      // Real content was typed into the pending marker — it's now just
      // normal formatted text, not a placeholder waiting for input.
      pendingSpanRef.current = null;
      pendingMarksRef.current = null;
    }

    if (!typingTimerRef.current) {
      typingBaselineRef.current = lastSnapshotRef.current;
    }

    const html = el.innerHTML;
    onChange(sanitizeRichText(html));

    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      typingTimerRef.current = null;
      const baseline = typingBaselineRef.current;
      typingBaselineRef.current = null;
      if (baseline) {
        pushHistory(baseline);
        lastSnapshotRef.current = snapshot() ?? baseline;
      }
    }, TYPING_DEBOUNCE_MS);
  }

  // ---- Undo / redo — fully replaces native browser undo (see the keydown
  // handler below), since the browser's own undo stack has no idea a
  // toolbar operation's direct innerHTML write ever happened and the two
  // running side by side would produce confusing, order-inconsistent
  // results. ----

  function restoreSnapshot(el: HTMLDivElement, entry: HistoryEntry) {
    el.innerHTML = entry.html;
    if (document.activeElement !== el) el.focus();
    const range = offsetsToRange(el, entry.start, entry.end);
    const sel = window.getSelection();
    if (range && sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    onChange(sanitizeRichText(entry.html));
    updateActiveStates();
  }

  function undo() {
    flushTypingBurst();
    const el = ref.current;
    const past = pastRef.current;
    if (!el || past.length === 0) return;
    const current = snapshot() ?? { html: el.innerHTML, start: 0, end: 0 };
    const prev = past.pop()!;
    futureRef.current.push(current);
    restoreSnapshot(el, prev);
    lastSnapshotRef.current = prev;
    forceHistoryRender((t) => t + 1);
  }

  function redo() {
    flushTypingBurst();
    const el = ref.current;
    const future = futureRef.current;
    if (!el || future.length === 0) return;
    const current = snapshot() ?? { html: el.innerHTML, start: 0, end: 0 };
    const next = future.pop()!;
    pastRef.current.push(current);
    restoreSnapshot(el, next);
    lastSnapshotRef.current = next;
    forceHistoryRender((t) => t + 1);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      redo();
    }
  }

  // ---- Blur cleanup ----

  function cleanupBareZwsp() {
    const el = ref.current;
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const toRemove: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      if ((node as Text).data === ZWSP) toRemove.push(node as Text);
      node = walker.nextNode();
    }
    toRemove.forEach((t) => t.remove());
  }

  function handleBlur() {
    const span = pendingSpanRef.current;
    pendingSpanRef.current = null;
    pendingMarksRef.current = null;
    if (span && span.textContent === ZWSP && span.parentNode) span.remove();
    cleanupBareZwsp();
    flushTypingBurst();
    if (ref.current) onChange(sanitizeRichText(ref.current.innerHTML));
  }

  // ---- initialFormat seeding ----

  function seedInitialFormat() {
    if (!initialFormat || seededTemplateRef.current) return;
    const el = ref.current;
    if (!el) return;
    seededTemplateRef.current = true;
    const marks: MarkSet = {};
    if (initialFormat.bold) marks.bold = true;
    if (initialFormat.italic) marks.italic = true;
    if (initialFormat.underline) marks.underline = true;
    if (initialFormat.dim) marks.dim = true;
    if (initialFormat.size !== NORMAL_SIZE) marks.size = initialFormat.size;
    if (initialFormat.color) marks.color = initialFormat.color;
    if (Object.keys(marks).length === 0) return;

    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    pendingMarksRef.current = marks;
    renderPendingMarker(el, 0, marks);
  }

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex flex-wrap gap-1 border-b border-neutral-700 p-1">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleMark('bold')}
          aria-label="Bold"
          aria-pressed={!!active.bold}
          className={`rounded p-1 ${
            active.bold
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleMark('italic')}
          aria-label="Italic"
          aria-pressed={!!active.italic}
          className={`rounded p-1 ${
            active.italic
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Italic size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleMark('underline')}
          aria-label="Underline"
          aria-pressed={!!active.underline}
          className={`rounded p-1 ${
            active.underline
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Underline size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggleMark('dim')}
          aria-label="Dim text"
          aria-pressed={!!active.dim}
          className={`rounded p-1 ${
            active.dim
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <EyeDashed size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyTextTransform((s) => s.toUpperCase())}
          aria-label="Capitalize"
          title="Capitalize"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <CaseUpper size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
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
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClick}
              aria-label="Text color"
              aria-pressed={open || !!active.color}
              className={`rounded p-1 ${
                active.color
                  ? 'bg-neutral-700 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
              }`}
              style={active.color ? { color: COLOR_PALETTE[active.color as keyof typeof COLOR_PALETTE] } : undefined}
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
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setColor(active.color === key ? null : key);
                    close();
                  }}
                  aria-label={key}
                  aria-pressed={active.color === key}
                  className={`h-6 w-6 rounded-full border ${
                    active.color === key ? 'border-neutral-100' : 'border-neutral-700'
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
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepSize(-1)}
          aria-label="Smaller text"
          title="Smaller text"
          className="rounded px-1.5 text-xs leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepSize(1)}
          aria-label="Bigger text"
          title="Bigger text"
          className="rounded px-1.5 text-lg leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
        <div className="w-px bg-neutral-700" />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Undo2 size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Redo2 size={14} />
        </button>
      </div>
      <div
        ref={ref}
        contentEditable
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          updateActiveStates();
          if (!value.trim()) seedInitialFormat();
        }}
        onBlur={handleBlur}
        data-placeholder={placeholder}
        className="rich-text-content min-h-[2.5rem] rounded-b-md px-3 py-2 text-sm outline-none empty:before:text-neutral-500 empty:before:content-[attr(data-placeholder)]"
      />
    </div>
  );
}
