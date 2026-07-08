// DOM-based allowlist sanitizer for the rich text feature (bold/italic/underline,
// plus a fixed 5-step font-size scale). Deliberately not regex-based — regex
// HTML sanitizers are a classic source of bypass bugs. Uses a <template>
// element, which parses HTML without executing scripts or loading resources
// (unlike setting .innerHTML on a live element), so this is safe to run on
// untrusted strings.
const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'BR', 'DIV', 'SPAN', 'IMG', 'AUDIO']);

// Font size is deliberately NOT a free-form style attribute (arbitrary CSS
// values are a needless risk for a feature that only needs 4 fixed steps).
// Values render via CSS in globals.css targeting [data-size="N"].
export const FONT_SIZE_VALUES = ['1', '2', '4', '5'] as const;
const ALLOWED_SIZES = new Set<string>(FONT_SIZE_VALUES);

// A media id is either an uploaded file (matching what the upload routes
// produce) or a "pending:<uuid>" placeholder queued locally while offline
// (see lib/mediaSync.ts) — anything else is meaningless and gets unwrapped.
const UPLOADED_MEDIA_RE = /^[0-9a-f-]{36}\.(webp|m4a)$/;
const PENDING_MEDIA_RE = /^pending:[0-9a-f-]{36}$/;

// A required description for an image/audio field — becomes the img's real
// `alt` (accessibility) or, for audio (no native alt), its `title`. Also
// what makes media-only fields findable in search/browse (see
// lib/search.ts's extractSearchableText), since there's otherwise no text
// content to match against. Capped defensively; not meant to hold more than
// a short label.
const MAX_LABEL_LENGTH = 300;
function sanitizeLabel(raw: string | null): string {
  return (raw ?? '').slice(0, MAX_LABEL_LENGTH);
}

export function sanitizeRichText(html: string): string {
  if (typeof document === 'undefined') return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  sanitizeNode(template.content);
  trimBrTags(template.content);
  collapseConsecutiveBrs(template.content);
  return template.innerHTML;
}

/** Trims leading/trailing <br>s and collapses runs of consecutive ones,
 * without the full sanitizeNode pass — for content assembled from pieces
 * that are each already individually sanitized (e.g. a custom note type's
 * front/back, built by joining several fields' stored HTML with '<br>' at
 * replay time in lib/sync.ts). An empty/unused field in that join
 * contributes nothing but its separator, which otherwise stacks into a
 * leading/trailing or doubled-up <br> right at the field boundary — the
 * same shape of artifact sanitizeRichText already prevents within a single
 * field, just showing up here instead since the join happens after each
 * field was already sanitized on its own. */
export function cleanupBrs(html: string): string {
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  trimBrTags(template.content);
  collapseConsecutiveBrs(template.content);
  return template.innerHTML;
}

function trimBrTags(fragment: DocumentFragment) {
  // Trim leading <br> tags
  while (fragment.firstChild) {
    const first = fragment.firstChild;
    if (first.nodeType === 1 && (first as HTMLElement).tagName === 'BR') {
      fragment.removeChild(first);
    } else if (first.nodeType === 3 && !(first as Text).data.trim()) {
      fragment.removeChild(first);
    } else {
      break;
    }
  }

  // Trim trailing <br> tags
  while (fragment.lastChild) {
    const last = fragment.lastChild;
    if (last.nodeType === 1 && (last as HTMLElement).tagName === 'BR') {
      fragment.removeChild(last);
    } else if (last.nodeType === 3 && !(last as Text).data.trim()) {
      fragment.removeChild(last);
    } else {
      break;
    }
  }
}

function collapseConsecutiveBrs(fragment: DocumentFragment) {
  const brs = Array.from(fragment.querySelectorAll('br'));
  let consecutiveCount = 0;
  for (const br of brs) {
    let next = br.nextSibling;
    while (next && next.nodeType === 3 && !next.textContent?.trim()) {
      next = next.nextSibling;
    }
    if (next && next.nodeType === 1 && (next as HTMLElement).tagName === 'BR') {
      consecutiveCount++;
      if (consecutiveCount >= 2) {
        br.remove();
      }
    } else {
      consecutiveCount = 0;
    }
  }
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
      // A span only exists here to carry a size and/or a dim flag — one with
      // neither is meaningless (e.g. pasted from elsewhere), so unwrap it
      // like any other disallowed content instead of leaving an empty
      // wrapper.
      const size = el.getAttribute('data-size');
      const validSize = size && ALLOWED_SIZES.has(size) ? size : null;
      const dim = el.hasAttribute('data-dim');
      if (!validSize && !dim) {
        unwrap(node, el);
        continue;
      }
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      if (validSize) el.setAttribute('data-size', validSize);
      if (dim) el.setAttribute('data-dim', '');
      sanitizeNode(el);
      continue;
    }
    if (el.tagName === 'IMG' || el.tagName === 'AUDIO') {
      const id = el.getAttribute('data-media-id');
      const extension = el.tagName === 'IMG' ? '.webp' : '.m4a';
      const valid =
        !!id && ((UPLOADED_MEDIA_RE.test(id) && id.endsWith(extension)) || PENDING_MEDIA_RE.test(id));
      if (!valid) {
        unwrap(node, el);
        continue;
      }
      // Read the label before the attribute-clearing loop below removes it.
      const label = sanitizeLabel(el.tagName === 'IMG' ? el.getAttribute('alt') : el.getAttribute('title'));
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      el.setAttribute('data-media-id', id);
      el.setAttribute('contenteditable', 'false');
      // A pending (not-yet-uploaded) id has no real URL yet — the
      // RichText/RichTextInput rehydration effect fills in `src` from the
      // locally-queued blob instead. An uploaded id's `src` is always
      // regenerated from its id here, never trusted from stored HTML — that
      // closes off arbitrary external src injection (e.g. a beacon URL)
      // from any future/old/pasted content, since the id is the one
      // validated source of truth.
      if (UPLOADED_MEDIA_RE.test(id)) el.setAttribute('src', `/api/media/${id}`);
      if (el.tagName === 'IMG') el.setAttribute('alt', label);
      // controls (and never autoplay) is forced unconditionally on AUDIO so
      // stored content can never render as an invisible or self-playing
      // element regardless of what produced the HTML.
      if (el.tagName === 'AUDIO') {
        el.setAttribute('controls', '');
        el.setAttribute('title', label);
      }
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

/** Like stripHtml, but also pulls in image/audio labels (alt/title) — a
 * media-only field has no text content at all, so without this it would be
 * both unsearchable and, in a preview list, blank. */
export function extractSearchableText(html: string): string {
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;

  // Replace <br> tags with a space so separate lines/fields do not run together.
  template.content.querySelectorAll('br').forEach((br) => {
    br.replaceWith(document.createTextNode(' '));
  });

  // Ensure block elements have spacing between them
  template.content.querySelectorAll('div, p').forEach((el) => {
    if (el.nextSibling) {
      el.after(document.createTextNode(' '));
    }
  });

  const text = template.content.textContent ?? '';
  const labels: string[] = [];
  template.content.querySelectorAll('img, audio').forEach((el) => {
    const label = el.tagName === 'IMG' ? el.getAttribute('alt') : el.getAttribute('title');
    if (label) labels.push(label);
  });
  return [text, ...labels].join(' ').replace(/\s+/g, ' ').trim();
}
