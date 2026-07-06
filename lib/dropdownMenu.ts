// Shared by every "..." actions dropdown (deck list, note-type list, card
// rows) — flips the menu to open upward instead of down when there isn't
// enough room below the trigger before the viewport edge.
const DROPDOWN_MENU_HEIGHT = 60;

export function shouldDropUp(triggerRect: DOMRect): boolean {
  return window.innerHeight - triggerRect.bottom < DROPDOWN_MENU_HEIGHT;
}
