'use client';

import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline } from 'lucide-react';
import { sanitizeRichText } from '@/lib/sanitize';

interface RichTextInputProps {
  value: string; // sanitized HTML
  onChange: (html: string) => void;
  placeholder?: string;
}

const MIN_SIZE = 1;
const MAX_SIZE = 5;
const NORMAL_SIZE = 3;

export function RichTextInput({ value, onChange, placeholder }: RichTextInputProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState({ bold: false, italic: false, underline: false });

  // Sync external value changes (e.g. switching which card is open) — but
  // never while this field has focus. Echoing the value back through the DOM
  // while actively editing destroys the live cursor/selection (contentEditable
  // has no notion of "just update the diff" like a controlled <input> does;
  // setting .innerHTML tears down and recreates every node), which is what
  // was moving the cursor to the start after typing and collapsing the
  // selection right after a toolbar click.
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value;
    }
  }, [value]);

  function updateActiveStates() {
    if (document.activeElement !== ref.current) return;
    setActive({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
    });
  }

  useEffect(() => {
    document.addEventListener('selectionchange', updateActiveStates);
    return () => document.removeEventListener('selectionchange', updateActiveStates);
  }, []);

  function exec(command: string) {
    document.execCommand(command);
    ref.current?.focus();
    handleInput();
    updateActiveStates();
  }

  // Reads the size level at the start of the selection by walking up to the
  // nearest [data-size] ancestor; defaults to "normal" if there isn't one. A
  // selection spanning multiple different sizes just uses its start point —
  // a deliberate simplification for a 2-button stepper, not a full editor.
  function getCurrentLevel(range: Range): number {
    let node: Node | null = range.startContainer;
    // Programmatic selections (select-all, our own post-apply restore) often
    // start in an ELEMENT container with the sized span as the child at
    // startOffset rather than inside it — descend one level so the ancestor
    // walk below can see that span too.
    if (node.nodeType === Node.ELEMENT_NODE && node.childNodes[range.startOffset]) {
      node = node.childNodes[range.startOffset];
    }
    while (node && node !== ref.current) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'SPAN') {
        const size = (node as HTMLElement).getAttribute('data-size');
        if (size) return Number(size);
      }
      node = node.parentNode;
    }
    return NORMAL_SIZE;
  }

  // Unwraps any [data-size] span the given range overlaps, returning the
  // nodes that were moved out (in document order). A range that only
  // partially overlaps a sized span unwraps the whole span rather than
  // splitting it — a deliberate simplification, not full partial-range
  // formatting.
  //
  // Callers must rebuild the selection from the returned nodes afterward
  // rather than reusing their old Range object — moving a node out from
  // under a removed ancestor doesn't reliably keep existing Range boundary
  // points valid across engines, even though the node itself is preserved.
  function unwrapOverlappingSizes(range: Range): ChildNode[] {
    if (!ref.current) return [];
    const moved: ChildNode[] = [];
    ref.current.querySelectorAll('span[data-size]').forEach((span) => {
      if (!range.intersectsNode(span)) return;
      const parent = span.parentNode;
      if (!parent) return;
      const children = Array.from(span.childNodes);
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      moved.push(...children);
    });
    return moved;
  }

  // execCommand is used only because it's the browser's own selection-aware
  // wrapping logic (handling partial/multi-element selections correctly is
  // genuinely fiddly to reimplement). Its <font size="N"> output is never
  // stored — it's rewritten into our own <span data-size="N"> immediately
  // below, or unwrapped entirely for "normal" (execCommand only recognizes
  // its own <font> tags as "sized", so fontSize('3') is a silent no-op on
  // text already wrapped in our custom spans).
  function applyFontSize(level: number) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const originalRange = sel.getRangeAt(0).cloneRange();

    const moved = unwrapOverlappingSizes(originalRange);

    const newRange = document.createRange();
    if (moved.length > 0) {
      newRange.setStartBefore(moved[0]);
      newRange.setEndAfter(moved[moved.length - 1]);
    } else {
      newRange.setStart(originalRange.startContainer, originalRange.startOffset);
      newRange.setEnd(originalRange.endContainer, originalRange.endOffset);
    }
    sel.removeAllRanges();
    sel.addRange(newRange);

    if (level === NORMAL_SIZE) {
      ref.current?.focus();
      handleInput();
      return;
    }

    document.execCommand('fontSize', false, String(level));
    ref.current?.focus();

    const newSpans: HTMLElement[] = [];
    ref.current?.querySelectorAll('font[size]').forEach((fontEl) => {
      const parent = fontEl.parentNode;
      if (!parent) return;
      const span = document.createElement('span');
      span.setAttribute('data-size', String(level));
      while (fontEl.firstChild) span.appendChild(fontEl.firstChild);
      parent.replaceChild(span, fontEl);
      newSpans.push(span);
    });

    // The rewrite moves the font elements' children through a detached span,
    // which collapses the live selection — rebuild it over the new spans so
    // the text stays selected (the unwrap-to-normal path above already does
    // the equivalent with its `moved` nodes).
    if (newSpans.length > 0) {
      // Anchor INSIDE the spans (not before/after them) so getCurrentLevel's
      // ancestor walk finds the size on the next step — anchoring outside
      // made a second size step read "normal" and re-apply the same level.
      const range = document.createRange();
      const last = newSpans[newSpans.length - 1];
      range.setStart(newSpans[0], 0);
      range.setEnd(last, last.childNodes.length);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    handleInput();
  }

  function step(delta: number) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const current = getCurrentLevel(sel.getRangeAt(0));
    const next = Math.min(MAX_SIZE, Math.max(MIN_SIZE, current + delta));
    if (next === current) return;
    applyFontSize(next);
  }

  function handleInput() {
    if (!ref.current) return;
    onChange(sanitizeRichText(ref.current.innerHTML));
  }

  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex gap-1 border-b border-neutral-700 p-1">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('bold')}
          aria-label="Bold"
          aria-pressed={active.bold}
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
          onClick={() => exec('italic')}
          aria-label="Italic"
          aria-pressed={active.italic}
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
          onClick={() => exec('underline')}
          aria-label="Underline"
          aria-pressed={active.underline}
          className={`rounded p-1 ${
            active.underline
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Underline size={14} />
        </button>
        <div className="mx-1 w-px bg-neutral-700" />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => step(-1)}
          aria-label="Smaller text"
          title="Smaller text"
          className="rounded px-1.5 text-xs leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => step(1)}
          aria-label="Bigger text"
          title="Bigger text"
          className="rounded px-1.5 text-lg leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
      </div>
      <div
        ref={ref}
        contentEditable
        onInput={handleInput}
        onFocus={updateActiveStates}
        data-placeholder={placeholder}
        className="min-h-[2.5rem] px-3 py-2 text-sm outline-none empty:before:text-neutral-500 empty:before:content-[attr(data-placeholder)]"
      />
    </div>
  );
}
