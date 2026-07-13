'use client';

import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline, EyeDashed } from 'lucide-react';
import { sanitizeRichText } from '@/lib/sanitize';
import type { TextFormat } from '@/lib/db';

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

const MIN_SIZE = 1;
const MAX_SIZE = 5;
const NORMAL_SIZE = 3;

export function RichTextInput({
  value,
  onChange,
  placeholder,
  initialFormat,
  formatEntireValue,
}: RichTextInputProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState({ bold: false, italic: false, underline: false, dim: false });
  const seededTemplateRef = useRef(false);

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

  // Selects the whole field before delegating to a toolbar action — exec(),
  // toggleDim(), and applyFontSize() already correctly handle an arbitrary
  // (non-collapsed) selection, including a mixed-formatting one, so feeding
  // them a full-content range is all formatEntireValue needs; no change to
  // their own logic. Focuses first, then sets the range, matching
  // toggleDim's own note about re-focusing after setting a selection
  // clobbering it on some engines.
  function withWholeSelection(action: () => void) {
    if (!formatEntireValue) {
      action();
      return;
    }
    const el = ref.current;
    if (el) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    action();
  }

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

  function isNodeStyled(node: Node, command: string): boolean {
    let curr: Node | null = node;
    while (curr && curr !== ref.current) {
      if (curr.nodeType === Node.ELEMENT_NODE) {
        const el = curr as HTMLElement;
        const tag = el.tagName.toUpperCase();
        if (command === 'bold') {
          if (tag === 'B' || tag === 'STRONG') return true;
          const fw = el.style.fontWeight;
          if (fw === 'bold' || fw === 'bolder' || (parseInt(fw, 10) >= 600)) return true;
        } else if (command === 'italic') {
          if (tag === 'I' || tag === 'EM') return true;
          const fs = el.style.fontStyle;
          if (fs === 'italic' || fs === 'oblique') return true;
        } else if (command === 'underline') {
          if (tag === 'U' || tag === 'INS') return true;
          const td = el.style.textDecorationLine || el.style.textDecoration;
          if (td.includes('underline')) return true;
        }
      }
      curr = curr.parentNode;
    }
    try {
      const parentEl = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (parentEl) {
        const style = window.getComputedStyle(parentEl);
        if (command === 'bold') {
          const fw = style.fontWeight;
          if (fw === 'bold' || fw === 'bolder' || parseInt(fw, 10) >= 600) return true;
        } else if (command === 'italic') {
          if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') return true;
        } else if (command === 'underline') {
          if (style.textDecorationLine.includes('underline') || style.textDecoration.includes('underline')) return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function exec(command: string) {
    const sel = window.getSelection();
    const isOn = document.queryCommandState(command);
    if (isOn && sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (!range.collapsed) {
        const container = range.commonAncestorContainer;
        const root = container.nodeType === Node.TEXT_NODE ? container.parentNode! : container;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n = walker.nextNode();
        let hasMixed = false;
        while (n) {
          if (range.intersectsNode(n) && (n as Text).data.trim().length > 0) {
            if (!isNodeStyled(n, command)) {
              hasMixed = true;
              break;
            }
          }
          n = walker.nextNode();
        }
        if (hasMixed) {
          // Force-apply: turn off, then turn back on so everything is styled.
          document.execCommand(command);
          document.execCommand(command);
          ref.current?.focus();
          handleInput();
          updateActiveStates();
          return;
        }
      }
    }
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
    // The walk above only ever looks *upward* from a single point, so it
    // never finds a [data-size] span nested *inside* whatever the range
    // starts at rather than being one of its ancestors. That's exactly the
    // shape formatEntireValue's withWholeSelection produces: it selects the
    // *entire* field via selectNodeContents(el), so the one-level descend
    // above lands on the outermost wrapper (e.g. a [data-dim] span with the
    // actual [data-size] nested inside it, not the other way around) —
    // walking up from there hits ref.current immediately and never sees
    // the nested size. Without this fallback, every size-stepper click on
    // a dimmed whole-field template read "normal" every time, so stepping
    // could only ever land one level away and then appeared to do nothing
    // on further clicks. Search the whole field directly as a fallback —
    // safe because this only ever runs when the ancestor walk found
    // nothing, i.e. either there's genuinely no size, or there's exactly
    // this nested-inside-another-wrapper shape to search for.
    const sizedSpan = ref.current?.querySelector('[data-size]');
    const size = sizedSpan?.getAttribute('data-size');
    if (size) return Number(size);
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

    // Treat a range holding nothing but the lone ZWSP marker of a pending
    // size span (stepping the size again right after a previous step,
    // before typing anything) the same as truly collapsed — the unwrap
    // above turns that prior pending span into a loose ZWSP text node,
    // which makes newRange technically non-collapsed even though there's
    // still no real content to preserve.
    const isPendingAnchorOnly = moved.length === 1 && moved[0].textContent === ZWSP;
    if (newRange.collapsed || isPendingAnchorOnly) {
      // No real text selected (just a caret, or only a pending marker) —
      // build the [data-size] span directly via seedFontSize's technique
      // instead of execCommand. execCommand('fontSize', ...) on a
      // genuinely empty/collapsed selection turned out to be unreliable
      // across engines: it can leave a raw <font size> in the DOM that
      // this function's own rewrite pass below never catches (that pass
      // only finds a <font> that already exists the instant it runs, not
      // one that only materializes later once real text is typed), or it
      // can apply no size at all — either way the size silently never
      // sticks. seedFontSize sidesteps execCommand entirely, the same way
      // toggleDim's collapsed-caret branch already does for dim.
      if (isPendingAnchorOnly) {
        // Collapsing newRange in place isn't guaranteed to update the live
        // selection on every engine (some clone the Range when it's added
        // via addRange rather than keeping a live reference) — explicitly
        // re-add it so seedFontSize's own sel.getRangeAt(0) sees the
        // collapsed state.
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }
      seedFontSize(level);
      ref.current?.focus();
      handleInput();
      return;
    }

    // Real text selected — wrap it directly in a [data-size] span via
    // Range.extractContents()/insertNode(), the exact same technique
    // toggleDim's own non-collapsed branch already uses for dim. This
    // sidesteps execCommand('fontSize', ...) entirely (see seedFontSize's
    // comment for why that's unreliable on a collapsed caret) — it was
    // also the culprit behind a case where stepping the size on text
    // already wrapped in a [data-dim] span got stuck after one step:
    // execCommand's own DOM restructuring around the existing dim wrapper
    // could leave the resulting <font> in a shape getCurrentLevel's
    // ancestor walk didn't find on the next step, so it kept reading
    // "normal" and re-applying the same one-step-away level instead of
    // progressing further. Plain Range surgery has no such interaction —
    // it only ever touches the size wrapper itself.
    const span = document.createElement('span');
    span.setAttribute('data-size', String(level));
    span.appendChild(newRange.extractContents());
    newRange.insertNode(span);
    ref.current?.focus();

    // Anchor the selection INSIDE the span (not before/after it) so
    // getCurrentLevel's ancestor walk finds the size on the next step —
    // anchoring outside made a second size step read "normal" and
    // re-apply the same level.
    const range = document.createRange();
    range.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(range);

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

  function isDimmed(range: Range): boolean {
    if (range.collapsed) {
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
    // Non-collapsed: every non-whitespace text node inside the range must be
    // inside a [data-dim] ancestor in the live DOM.
    const container = range.commonAncestorContainer;
    const root = container.nodeType === Node.TEXT_NODE ? container.parentNode! : container;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    let hasText = false;
    while (n) {
      if (range.intersectsNode(n) && (n as Text).data.trim().length > 0) {
        hasText = true;
        let p: Node | null = n;
        let dimmed = false;
        while (p && p !== ref.current) {
          if (p.nodeType === Node.ELEMENT_NODE && (p as HTMLElement).hasAttribute('data-dim')) {
            dimmed = true;
            break;
          }
          p = p.parentNode;
        }
        if (!dimmed) return false;
      }
      n = walker.nextNode();
    }
    return hasText;
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
  function isInactiveFormattingElement(el: HTMLElement): boolean {
    const tag = el.tagName.toUpperCase();
    if (tag === 'B' || tag === 'STRONG' || el.style.fontWeight === 'bold') {
      return !document.queryCommandState('bold');
    }
    if (tag === 'I' || tag === 'EM' || el.style.fontStyle === 'italic') {
      return !document.queryCommandState('italic');
    }
    if (tag === 'U' || tag === 'INS' || (el.style.textDecorationLine || el.style.textDecoration || '').includes('underline')) {
      return !document.queryCommandState('underline');
    }
    return false;
  }

  function getCleanInsertionRange(range: Range): Range {
    const newRange = range.cloneRange();
    if (!range.collapsed) return newRange;

    let container = range.startContainer;
    let offset = range.startOffset;

    while (true) {
      if (container.nodeType === Node.TEXT_NODE) {
        const textVal = container.nodeValue || '';
        if (offset === textVal.length) {
          const parent = container.parentNode;
          if (parent && parent !== ref.current) {
            const idx = Array.from(parent.childNodes).indexOf(container as ChildNode);
            container = parent;
            offset = idx + 1;
            continue;
          }
        } else if (offset === 0) {
          const parent = container.parentNode;
          if (parent && parent !== ref.current) {
            const idx = Array.from(parent.childNodes).indexOf(container as ChildNode);
            container = parent;
            offset = idx;
            continue;
          }
        }
      } else if (container.nodeType === Node.ELEMENT_NODE) {
        const el = container as HTMLElement;
        const children = Array.from(el.childNodes);
        if (offset === children.length && el !== ref.current) {
          if (isInactiveFormattingElement(el)) {
            const parent = el.parentNode;
            if (parent) {
              const idx = Array.from(parent.childNodes).indexOf(el);
              container = parent;
              offset = idx + 1;
              continue;
            }
          }
        } else if (offset === 0 && el !== ref.current) {
          if (isInactiveFormattingElement(el)) {
            const parent = el.parentNode;
            if (parent) {
              const idx = Array.from(parent.childNodes).indexOf(el);
              container = parent;
              offset = idx;
              continue;
            }
          }
        }
      }
      break;
    }

    newRange.setStart(container, offset);
    newRange.setEnd(container, offset);
    return newRange;
  }

  // Splicing inline dim spans. Clicking the dim button with selection wraps
  // it in a [data-dim] span; clicking with just a caret inserts a pending
  // dim span (containing a ZWSP marker so it has visual layout width to hold
  // focus) and locks the button active, so the next characters typed are
  // dimmed. Clicking again with that pending span still empty pops the
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

    let originalRange = sel.getRangeAt(0).cloneRange();

    if (originalRange.collapsed) {
      originalRange = getCleanInsertionRange(originalRange);
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

    // unwrapOverlappingDim removes [data-dim] spans and moves their children
    // out into the surrounding DOM. It returns those moved child nodes so we
    // can reconstruct a selection over them after the mutation — originalRange
    // boundaries can become stale/collapsed after the span removal.
    const moved = unwrapOverlappingDim(originalRange);

    if (wasDimmed) {
      ref.current?.focus();
      handleInput();
      // Rebuild the selection from the now-unwrapped nodes synchronously —
      // this DOM mutation (unwrapOverlappingDim above) doesn't depend on
      // React re-rendering at all, so there's nothing to wait for. An
      // earlier version deferred this one tick via setTimeout "to ensure
      // React updates have finished rendering"; that was never actually
      // necessary, and crossing a macrotask boundary left a real window
      // where a fast follow-up action (e.g. immediately clicking the size
      // stepper right after dim) would run against the stale pre-rebuild
      // selection instead of waiting for this one.
      const currentSel = window.getSelection();
      if (currentSel) {
        currentSel.removeAllRanges();
        if (moved.length > 0) {
          const r = document.createRange();
          r.setStartBefore(moved[0]);
          r.setEndAfter(moved[moved.length - 1]);
          currentSel.addRange(r);
        } else {
          currentSel.addRange(originalRange);
        }
        updateActiveStates();
      }
      return;
    }

    // Not fully dimmed (none or mixed) → apply dim to the full original range.
    // originalRange is live and still covers the full original selection after
    // the unwrap (the unwrapped nodes are inside it, no boundaries removed).
    const span = document.createElement('span');
    span.setAttribute('data-dim', '');
    span.appendChild(originalRange.extractContents());
    originalRange.insertNode(span);

    ref.current?.focus();
    handleInput();

    // Select the newly dimmed contents synchronously — see the wasDimmed
    // branch's comment above for why the earlier setTimeout deferral here
    // was both unnecessary and actively harmful to a fast follow-up click.
    const currentSel = window.getSelection();
    if (currentSel) {
      const newRange = document.createRange();
      newRange.selectNodeContents(span);
      currentSel.removeAllRanges();
      currentSel.addRange(newRange);
      updateActiveStates();
    }
  }

  // Applies initialFormat's effects to the (still-empty) collapsed caret,
  // reusing the exact same "toggle with no selection" branches the toolbar
  // buttons themselves use for a manual click — bold/italic/underline/size
  // ride the browser's own native typing-state (no DOM trace at all until
  // something is actually typed), and dim reuses its existing pending-span
  // mechanism, whose blur-time cleanup already handles "opened but never
  // typed into" for free. Guarded so it only ever fires once per mount.
  //
  // Must run synchronously inside the triggering focus event (see the
  // onFocus handler below) — document.execCommand only counts as
  // originating from a user gesture while still on the same call stack as
  // the event that started it. An earlier version deferred this one tick
  // via setTimeout to let the browser finish placing its own collapsed
  // selection first; that crossed a macrotask boundary, which silently
  // strips execCommand's gesture privilege on iOS Safari — bold/italic/
  // underline/size would appear to do nothing there (Safari didn't error,
  // it just never applied). Placing the collapsed selection ourselves
  // below removes the need to wait for the browser at all.
  // Inserts a pending [data-size] span exactly the way toggleDim's own
  // collapsed-caret branch inserts a [data-dim] one — a proven, DOM-only
  // technique that never touches execCommand at all. applyFontSize (used
  // by the size-stepper buttons) calls this directly for its own
  // collapsed-selection case too — execCommand('fontSize', ...), which it
  // used to rely on there, turned out to be genuinely unreliable
  // specifically for a collapsed, empty selection: depending on engine it
  // could leave a raw <font size> in the DOM that never got rewritten (the
  // old rewrite pass only caught a <font> that already existed the instant
  // it ran, not one that only materialized later once real text was
  // typed), or applied no size at all.
  function seedFontSize(level: number) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;
    const span = document.createElement('span');
    span.setAttribute('data-size', String(level));
    const textNode = document.createTextNode(ZWSP);
    span.appendChild(textNode);
    range.insertNode(span);
    const newRange = document.createRange();
    newRange.setStart(textNode, 1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  function seedInitialFormat() {
    if (!initialFormat || seededTemplateRef.current) return;
    const el = ref.current;
    if (!el) return;
    seededTemplateRef.current = true;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    if (initialFormat.bold) exec('bold');
    if (initialFormat.italic) exec('italic');
    if (initialFormat.underline) exec('underline');
    if (initialFormat.dim) toggleDim();
    if (initialFormat.size !== NORMAL_SIZE) seedFontSize(initialFormat.size);
    handleInput();
  }

  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex gap-1 border-b border-neutral-700 p-1">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => withWholeSelection(() => exec('bold'))}
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
          onClick={() => withWholeSelection(() => exec('italic'))}
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
          onClick={() => withWholeSelection(() => exec('underline'))}
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
          onClick={() => withWholeSelection(toggleDim)}
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
          onClick={() => withWholeSelection(() => step(-1))}
          aria-label="Smaller text"
          title="Smaller text"
          className="rounded px-1.5 text-xs leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => withWholeSelection(() => step(1))}
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
        onFocus={() => {
          updateActiveStates();
          // Called synchronously (no setTimeout) — see seedInitialFormat's
          // own comment for why that matters on iOS Safari.
          if (!value.trim()) seedInitialFormat();
        }}
        onBlur={() => {
          finalizePendingDim();
          cleanupEmptyDimSpans();
          cleanupBoundaryMarkers();
          handleInput();
        }}
        data-placeholder={placeholder}
        className="rich-text-content min-h-[2.5rem] rounded-b-md px-3 py-2 text-sm outline-none empty:before:text-neutral-500 empty:before:content-[attr(data-placeholder)]"
      />
    </div>
  );
}
