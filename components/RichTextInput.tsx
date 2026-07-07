'use client';

import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline, EyeDashed } from 'lucide-react';
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
  const [active, setActive] = useState({ bold: false, italic: false, underline: false, dim: false });

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
    const sel = window.getSelection();
    setActive({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      dim: sel && sel.rangeCount > 0 ? isDimmed(sel.getRangeAt(0)) : false,
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

  // Same ancestor-walk shape as getCurrentLevel above, but for a boolean
  // instead of a size level.
  function isDimmed(range: Range): boolean {
    let node: Node | null = range.startContainer;
    if (node.nodeType === Node.ELEMENT_NODE && node.childNodes[range.startOffset]) {
      node = node.childNodes[range.startOffset];
    }
    while (node && node !== ref.current) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).hasAttribute('data-dim')) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  // Same shape as unwrapOverlappingSizes above, but for [data-dim] spans.
  function unwrapOverlappingDim(range: Range): ChildNode[] {
    if (!ref.current) return [];
    const moved: ChildNode[] = [];
    ref.current.querySelectorAll('span[data-dim]').forEach((span) => {
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

  // A zero-width space so a freshly-inserted, still-empty dim span has a
  // text node to hold the caret in (an <span></span> with zero children
  // can't reliably keep focus/caret position across browsers).
  const ZWSP = '​';

  // Same walk as isDimmed, but returns the span itself — needed to splice
  // the caret in/out of it for the no-selection ("typing state") case below.
  function findDimAncestor(node: Node | null): HTMLElement | null {
    while (node && node !== ref.current) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).hasAttribute('data-dim')) {
        return node as HTMLElement;
      }
      node = node.parentNode;
    }
    return null;
  }

  // Moves the caret out of `span` (stripping the leading ZWSP marker, or
  // dropping the whole span if nothing but the marker was ever typed into
  // it). Places the caret inside a fresh, plain (non-dim) text node
  // inserted right after the span — not at an element-level "one index
  // past the span" boundary. A boundary position like that has no node of
  // its own to anchor to, and several engines resolve typing there by
  // appending to the *preceding* node (the span we just exited) instead of
  // starting fresh content after it, which is exactly why turning dim off
  // wasn't visibly taking effect (new text kept rendering dim, and the
  // button re-highlighted the moment typing resumed). The marker node is
  // swept up later (see cleanupBoundaryMarkers) once real content surrounds
  // it and it's no longer needed to hold the caret.
  function exitDimSpan(span: HTMLElement) {
    const parent = span.parentNode;
    if (!parent) return;
    if (span.textContent?.startsWith(ZWSP)) {
      span.textContent = span.textContent.slice(1);
    }
    const placeholderOnly = span.textContent === '';
    const marker = document.createTextNode(ZWSP);
    if (placeholderOnly) {
      parent.replaceChild(marker, span);
    } else {
      parent.insertBefore(marker, span.nextSibling);
    }
    const sel = window.getSelection();
    if (!sel) return;
    const newRange = document.createRange();
    newRange.setStart(marker, 1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  // Removes bare (not inside any [data-dim]/[data-size] span) ZWSP marker
  // text nodes left behind by exitDimSpan once they're no longer needed —
  // safe to run wholesale on blur since nothing can still be relying on one
  // to hold the caret once focus has left the field.
  function cleanupBoundaryMarkers() {
    if (!ref.current) return;
    const walker = document.createTreeWalker(ref.current, NodeFilter.SHOW_TEXT);
    const toRemove: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      if (node.textContent === ZWSP) toRemove.push(node as Text);
      node = walker.nextNode();
    }
    toRemove.forEach((text) => text.remove());
  }

  // Tracks a dim span opened by a no-selection click on this specific
  // element (not by re-deriving "is the caret inside a dim span" from the
  // current selection each time) — the next click on the button always
  // means "close it", regardless of exactly where typing left the caret.
  const pendingDimSpanRef = useRef<HTMLElement | null>(null);

  function finalizePendingDim() {
    const span = pendingDimSpanRef.current;
    pendingDimSpanRef.current = null;
    if (span) exitDimSpan(span);
  }

  // A dim span left holding only the ZWSP placeholder means dim was toggled
  // on (or on then off) but nothing was ever typed into it — drop it so it
  // doesn't linger as an invisible, pointless span in the saved HTML.
  function cleanupEmptyDimSpans() {
    ref.current?.querySelectorAll('span[data-dim]').forEach((span) => {
      if (span === pendingDimSpanRef.current) return;
      if (span.textContent === '' || span.textContent === ZWSP) span.remove();
    });
  }

  // Wraps directly via Range.extractContents()/insertNode() rather than the
  // execCommand('fontSize')-as-wrapping trick applyFontSize uses above —
  // that trick briefly applies a real (huge, size-7) <font> tag to the
  // selection before this code gets a chance to rewrite it, and at least on
  // some engines that flash was visible/sticking around instead of being
  // swapped out synchronously. Opacity has no execCommand equivalent worth
  // routing through anyway, so a plain Range wrap sidesteps the whole issue.
  //
  // A collapsed (no text selected) click instead toggles a "typing state",
  // matching how bold/italic/underline already behave natively: turning on
  // inserts an empty dim span and parks the caret inside it so whatever's
  // typed next lands inside (and inherits the style); turning off moves the
  // caret back out to just after it.
  function toggleDim() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    // A pending span is only ever closed explicitly by this button — always
    // treat the next click as "close it" rather than re-checking whether the
    // caret is still literally inside it (see exitDimSpan's comment).
    // No re-focus() calls in this collapsed-caret branch (unlike exec()
    // below, which needs one so execCommand has a focused editing context
    // to act on) — the field is already focused here (the button's
    // onMouseDown preventDefault keeps it that way), and redundantly calling
    // .focus() on an already-focused contentEditable has been observed to
    // reset the caret to the end of the content on some engines, silently
    // destroying the exact selection/caret position just set below.
    if (pendingDimSpanRef.current) {
      finalizePendingDim();
      handleInput();
      updateActiveStates();
      return;
    }

    const originalRange = sel.getRangeAt(0).cloneRange();

    if (originalRange.collapsed) {
      const dimAncestor = findDimAncestor(originalRange.startContainer);
      if (dimAncestor) {
        exitDimSpan(dimAncestor);
      } else {
        const span = document.createElement('span');
        span.setAttribute('data-dim', '');
        const textNode = document.createTextNode(ZWSP);
        span.appendChild(textNode);
        originalRange.insertNode(span);
        pendingDimSpanRef.current = span;
        const newRange = document.createRange();
        newRange.setStart(textNode, 1);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
      handleInput();
      updateActiveStates();
      return;
    }

    const wasDimmed = isDimmed(originalRange);

    const moved = unwrapOverlappingDim(originalRange);

    const rangeToWrap = document.createRange();
    if (moved.length > 0) {
      rangeToWrap.setStartBefore(moved[0]);
      rangeToWrap.setEndAfter(moved[moved.length - 1]);
    } else {
      rangeToWrap.setStart(originalRange.startContainer, originalRange.startOffset);
      rangeToWrap.setEnd(originalRange.endContainer, originalRange.endOffset);
    }

    if (wasDimmed) {
      sel.removeAllRanges();
      sel.addRange(rangeToWrap);
      handleInput();
      updateActiveStates();
      return;
    }

    const span = document.createElement('span');
    span.setAttribute('data-dim', '');
    span.appendChild(rangeToWrap.extractContents());
    rangeToWrap.insertNode(span);

    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(newRange);

    handleInput();
    updateActiveStates();
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
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleDim}
          aria-label="Dim text"
          aria-pressed={active.dim}
          className={`rounded p-1 ${
            active.dim
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <EyeDashed size={14} />
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
        onBlur={() => {
          finalizePendingDim();
          cleanupEmptyDimSpans();
          cleanupBoundaryMarkers();
          handleInput();
        }}
        data-placeholder={placeholder}
        className="rich-text-content min-h-[2.5rem] px-3 py-2 text-sm outline-none empty:before:text-neutral-500 empty:before:content-[attr(data-placeholder)]"
      />
    </div>
  );
}
