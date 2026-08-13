// Shared by every "..." actions dropdown (deck list, note-type list, card
// rows) — flips the menu to open upward instead of down when there isn't
// enough room below the trigger. Matches the real rendered height of the
// menu itself: every call site renders one row of h-8 (32px) icon buttons
// inside a p-0.5 (2px) + border (1px) box, ~38px, plus the mt-1 (4px) gap
// from the trigger — ~42px, rounded up for a little slack. Was previously
// 60, a rough overestimate that (at the deck list's ~48px per-row spacing,
// h-10 rows + gap-2) was just barely larger than one row's worth of extra
// clearance, so it also flipped the *second*-to-last row upward even
// though a full row of headroom below it was actually enough.
const DROPDOWN_MENU_HEIGHT = 44;

// Walks up from the trigger to find whichever ancestor actually clips/
// scrolls it (e.g. a ScrollFade region) — the trigger's own visible bottom
// edge is bounded by that container, not by the viewport, so a dropdown
// near the bottom of a scrolled list needs to check room against the
// container's edge, not window.innerHeight (which would otherwise still
// report plenty of room below and open downward into the clipped-off area,
// e.g. under the deck list's "Add deck" button).
export function nearestScrollContainer(el: Element): Element | null {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    // scrollHeight > clientHeight (real vertical overflow), not just the
    // computed style — a CSS quirk means overflow-y computes to 'auto' on
    // an element that only ever set overflow-x: auto (e.g.
    // TiptapFieldInput's horizontally-scrolling toolbar): per the overflow
    // spec, if one axis is non-'visible' and the other is left/set to
    // 'visible', that 'visible' one computes to 'auto' too, regardless of
    // which axis or how it was specified. Without this check, a purely
    // horizontal scroller got treated as this trigger's vertical scroll
    // container, and — being only as tall as one row of toolbar buttons —
    // made shouldDropUp below always think there was no room and flip the
    // menu upward off-screen (confirmed: this broke the toolbar's own
    // align dropdown specifically once its row gained overflow-x-auto).
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function shouldDropUp(triggerEl: Element): boolean {
  const rect = triggerEl.getBoundingClientRect();
  const container = nearestScrollContainer(triggerEl);
  const bottomBound = container ? container.getBoundingClientRect().bottom : window.innerHeight;
  return bottomBound - rect.bottom < DROPDOWN_MENU_HEIGHT;
}
