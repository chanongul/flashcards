// Used by RichText.tsx's read-only display ONLY — NOT TiptapFieldInput's
// live editor, even though it needs the exact same "fade at the edge when
// there's more of a wide table to scroll to" hint. `.tableWrapper`/
// `.scroll-fade-x`'s own CSS-only background-gradient trick (see
// globals.css's own doc comment on that rule) isn't enough for either: a
// background layer always paints *behind* an element's own content, so it
// can only ever fade through genuinely transparent gaps in a table's own
// cell backgrounds — real but sparse — never the cell *text* itself, which
// is what a user is actually looking at. Confirmed insufficient in
// practice. A real overlay element, painted in *front* of the content, is
// the only way to visibly fade the text itself.
//
// This only works safely in RichText.tsx because that component owns its
// whole DOM subtree outright (raw sanitized HTML written via innerHTML,
// re-parsed fresh on every change) — there's no other system with its own
// opinion about what that DOM should look like. TiptapFieldInput's live
// editor is a fundamentally different situation: its tables live inside
// ProseMirror-managed DOM, and ProseMirror runs its own internal
// MutationObserver over that DOM specifically to detect and repair
// external changes. An earlier version of this used the exact same
// wrap-from-outside technique there too — confirmed, empirically, that it
// doesn't just risk trouble: ProseMirror "repairing" this wrapper retriggers
// the effect that installed it, which reinstalls it, which ProseMirror
// repairs again — an actual infinite loop (pegged a CPU core in testing),
// not just a theoretical concern. TiptapFieldInput's own tables fall back
// to the CSS-only fade instead; see its own doc comment for that tradeoff.
//
// Wraps `wrapper` (a .tableWrapper) in a brand new, dedicated `position:
// relative` anchor — not just reusing `wrapper`'s existing parent, which
// might hold other content or multiple tables, and would make the fade
// stretch across all of it instead of just this one table's own bounds.
// The anchor being a sibling of the scrolling element (not a descendant)
// is what keeps the fade visually pinned while `wrapper` itself scrolls —
// confirmed empirically that an absolutely positioned *descendant* of a
// scrolling container scrolls away *with* the content instead (its
// containing block's padding-box origin doesn't move when that box's own
// content scrolls — only the *visible portion* of the overflow changes) —
// same structural pattern ScrollFade.tsx and TiptapFieldInput's own
// toolbar fade both already use for the identical reason.
export function attachTableFade(wrapper: HTMLElement): () => void {
  // Idempotent — both call sites' effects can re-run on unrelated updates
  // (a re-render, another table elsewhere changing) without doubling up.
  if (wrapper.dataset.fadeAttached) return () => {};
  wrapper.dataset.fadeAttached = 'true';

  const anchor = document.createElement('div');
  anchor.style.position = 'relative';
  wrapper.replaceWith(anchor);
  anchor.appendChild(wrapper);

  function makeFade(side: 'left' | 'right') {
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.className = `pointer-events-none absolute ${side}-0 top-0 bottom-0 w-2 opacity-0 transition-opacity duration-150 ${
      side === 'left' ? 'bg-gradient-to-r' : 'bg-gradient-to-l'
    } from-neutral-900 to-transparent`;
    anchor.appendChild(el);
    return el;
  }
  const leftFade = makeFade('left');
  const rightFade = makeFade('right');

  const update = () => {
    leftFade.style.opacity = wrapper.scrollLeft > 1 ? '1' : '0';
    rightFade.style.opacity = wrapper.scrollLeft + wrapper.clientWidth < wrapper.scrollWidth - 1 ? '1' : '0';
  };
  update();
  wrapper.addEventListener('scroll', update);
  const ro = new ResizeObserver(update);
  ro.observe(wrapper);

  return () => {
    wrapper.removeEventListener('scroll', update);
    ro.disconnect();
    delete wrapper.dataset.fadeAttached;
    // Only unwrap if `anchor` is still actually wrapper's parent — a full
    // Tiptap NodeView remount could have already replaced/detached it,
    // in which case there's nothing left here worth restoring.
    if (wrapper.parentElement === anchor) anchor.replaceWith(wrapper);
  };
}
