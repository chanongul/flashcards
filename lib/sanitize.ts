// DOM-based allowlist sanitizer for the rich text feature (bold/italic/underline,
// plus a fixed 5-step font-size scale). Deliberately not regex-based — regex
// HTML sanitizers are a classic source of bypass bugs. Uses a <template>
// element, which parses HTML without executing scripts or loading resources
// (unlike setting .innerHTML on a live element), so this is safe to run on
// untrusted strings.
const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'BR', 'DIV', 'SPAN']);

// Font size is deliberately NOT a free-form style attribute (arbitrary CSS
// values are a needless risk for a feature that only needs 4 fixed steps).
// Values render via CSS in globals.css targeting [data-size="N"].
export const FONT_SIZE_VALUES = ['1', '2', '4', '5'] as const;
const ALLOWED_SIZES = new Set<string>(FONT_SIZE_VALUES);

export function sanitizeRichText(html: string): string {
  if (typeof document === 'undefined') return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  sanitizeNode(template.content);
  return template.innerHTML;
}

function unwrap(node: Node, el: HTMLElement) {
  sanitizeNode(el);
  while (el.firstChild) node.insertBefore(el.firstChild, el);
  node.removeChild(el);
}

function sanitizeNode(node: Node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      node.removeChild(child);
      continue;
    }
    const el = child as HTMLElement;
    if (!ALLOWED_TAGS.has(el.tagName)) {
      unwrap(node, el);
      continue;
    }
    if (el.tagName === 'SPAN') {
      // A span only exists here to carry a size — one without a valid size is
      // meaningless (e.g. pasted from elsewhere), so unwrap it like any other
      // disallowed content instead of leaving an empty wrapper.
      const size = el.getAttribute('data-size');
      if (!size || !ALLOWED_SIZES.has(size)) {
        unwrap(node, el);
        continue;
      }
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      el.setAttribute('data-size', size);
      sanitizeNode(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      el.removeAttribute(attr.name);
    }
    sanitizeNode(el);
  }
}

export function stripHtml(html: string): string {
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.textContent ?? '';
}
