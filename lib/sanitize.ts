// DOM-based allowlist sanitizer for the rich text feature (bold/italic/underline,
// plus a fixed 5-step font-size scale). Deliberately not regex-based — regex
// HTML sanitizers are a classic source of bypass bugs. Uses a <template>
// element, which parses HTML without executing scripts or loading resources
// (unlike setting .innerHTML on a live element), so this is safe to run on
// untrusted strings.
import {
  COLOR_PALETTE,
  MIN_IMAGE_WIDTH_PERCENT,
  MAX_IMAGE_WIDTH_PERCENT,
  MIN_AUDIO_WIDTH_PERCENT,
  MAX_AUDIO_WIDTH_PERCENT,
  ALIGN_VALUES,
  CODE_BLOCK_LANGUAGES,
} from './richTextModel';

// Deliberately NOT importing anything from lib/tiptapBlockExtensions.ts —
// that file pulls in Tiptap's table/list/code-block extensions, lowlight,
// and highlight.js's language grammars, none of which this file (run on
// every card render/sync, not just inside the editor) has any reason to
// carry. Constants both files need (ALIGN_VALUES above, CODE_BLOCK_
// LANGUAGES below) live in the dependency-free lib/richTextModel.ts instead
// — see that file's own comments.
// TBODY/THEAD/TFOOT deliberately excluded — Tiptap's Table node never emits
// them (its schema goes straight from `table` to `tr`), so allowing them
// here would just be an unrecognized wrapper ProseMirror's own parser
// doesn't expect; the default "not allowed -> unwrap" behavior below
// correctly flattens a pasted table's <tbody> etc. down to its <tr>
// children directly under <table>, matching the shape Tiptap actually
// parses.
const ALLOWED_TAGS = new Set([
  'B', 'I', 'U', 'BR', 'DIV', 'SPAN', 'IMG', 'AUDIO',
  'P', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR', 'PRE', 'CODE',
  'TABLE', 'TR', 'TD', 'TH',
]);
const ALLOWED_ALIGNS = new Set<string>(ALIGN_VALUES);
const ALLOWED_LANGUAGES = new Set<string>(CODE_BLOCK_LANGUAGES.map((l) => l.key));

// Font size is deliberately NOT a free-form style attribute (arbitrary CSS
// values are a needless risk for a feature that only needs 4 fixed steps).
// Values render via CSS in globals.css targeting [data-size="N"].
export const FONT_SIZE_VALUES = ['1', '2', '4', '5'] as const;
const ALLOWED_SIZES = new Set<string>(FONT_SIZE_VALUES);

// Same fixed-set reasoning as font size, for text color — see
// lib/richTextModel.ts's COLOR_PALETTE (the single source of truth for the
// actual key->hex mapping; this only needs the valid keys). Values render
// via CSS in globals.css targeting [data-color="key"].
const ALLOWED_COLORS = new Set(Object.keys(COLOR_PALETTE));

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
  trimEmptyParagraphs(template.content);
  collapseConsecutiveEmptyParagraphs(template.content);
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

// Genuinely bare — no element children (an img/audio-only paragraph has
// real content despite empty textContent, so this checks children.length,
// not just textContent) and no non-whitespace text.
function isEmptyParagraph(el: Element): boolean {
  return el.tagName === 'P' && el.children.length === 0 && !(el.textContent ?? '').trim();
}

// Same "don't let repeated Enter presses accumulate junk" protection
// trimBrTags/collapseConsecutiveBrs give the old flat/<br>-based model,
// retargeted to the new block-level unit: now that Enter creates a new
// paragraph (see BlockEssentials in lib/tiptapBlockExtensions.ts) instead
// of a <br>, the equivalent junk is a leading/trailing/doubled-up *empty
// paragraph* rather than a stray <br>.
function trimEmptyParagraphs(fragment: DocumentFragment) {
  while (fragment.firstChild) {
    const first = fragment.firstChild;
    if (first.nodeType === 1 && isEmptyParagraph(first as Element)) {
      fragment.removeChild(first);
    } else {
      break;
    }
  }
  while (fragment.lastChild) {
    const last = fragment.lastChild;
    if (last.nodeType === 1 && isEmptyParagraph(last as Element)) {
      fragment.removeChild(last);
    } else {
      break;
    }
  }
}

function collapseConsecutiveEmptyParagraphs(fragment: DocumentFragment) {
  const children = Array.from(fragment.children);
  let consecutiveCount = 0;
  for (const el of children) {
    if (isEmptyParagraph(el)) {
      consecutiveCount++;
      if (consecutiveCount >= 2) el.remove();
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

// Wraps `el`'s current children in a new `tagName` element, in place.
function wrapChildren(el: HTMLElement, tagName: string) {
  const wrapper = document.createElement(tagName);
  while (el.firstChild) wrapper.appendChild(el.firstChild);
  el.appendChild(wrapper);
}

function sanitizeNode(node: Node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      node.removeChild(child);
      continue;
    }
    const el = child as HTMLElement;
    if (el.tagName === 'FONT') {
      // Not in ALLOWED_TAGS, so this would otherwise hit the generic
      // disallowed-tag branch below and get unwrapped, silently discarding
      // the size. Legacy-data concern only, from the old RichTextInput
      // (removed — replaced by the Tiptap-based TiptapFieldInput, which
      // never uses execCommand and so can't produce this): some engines
      // (Safari, toggling font size on a collapsed caret rather than an
      // existing selection) implemented execCommand by leaving typed text
      // wrapped in a native <font size="N"> instead of the intended
      // <span data-size="N">. Already-stored content from back then can
      // still contain one, so this conversion stays even though nothing
      // currently in use produces it anymore.
      const size = el.getAttribute('size');
      const validSize = size && ALLOWED_SIZES.has(size) ? size : null;
      if (!validSize) {
        unwrap(node, el);
        continue;
      }
      sanitizeNode(el);
      const span = document.createElement('span');
      span.setAttribute('data-size', validSize);
      while (el.firstChild) span.appendChild(el.firstChild);
      node.insertBefore(span, el);
      node.removeChild(el);
      continue;
    }
    if (!ALLOWED_TAGS.has(el.tagName)) {
      unwrap(node, el);
      continue;
    }
    if (el.tagName === 'P' || el.tagName === 'BLOCKQUOTE') {
      // Only real attribute either can carry — see BlockAlign in
      // lib/tiptapBlockExtensions.ts, which renders alignment as
      // `data-align` (a fixed value) rather than an inline
      // `style="text-align: ..."`, matching every other formatting axis in
      // this schema.
      const align = el.getAttribute('data-align');
      const validAlign = align && ALLOWED_ALIGNS.has(align) ? align : null;
      sanitizeNode(el);
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      if (validAlign) el.setAttribute('data-align', validAlign);
      continue;
    }
    if (el.tagName === 'HR' || el.tagName === 'TR' || el.tagName === 'TABLE') {
      // No attributes worth keeping on any of these (see Table's own
      // `resizable: false` doc comment in lib/tiptapBlockExtensions.ts for
      // why a table specifically has no per-column width styling to
      // preserve) — recurse for TABLE/TR (real children); HR is a leaf.
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      sanitizeNode(el);
      continue;
    }
    if (el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'LI') {
      // OL's only kept attribute is `start` (resuming numbering somewhere
      // other than 1) — see OrderedList's own doc comment in
      // lib/tiptapBlockExtensions.ts for why `type` (roman/alpha markers)
      // isn't supported at all. A non-positive or non-numeric value is
      // meaningless, so it's dropped rather than trusted verbatim.
      const startRaw = el.tagName === 'OL' ? el.getAttribute('start') : null;
      const start = startRaw !== null ? parseInt(startRaw, 10) : NaN;
      const validStart = Number.isFinite(start) && start > 0 ? start : null;
      sanitizeNode(el);
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      if (validStart !== null && validStart !== 1) el.setAttribute('start', String(validStart));
      continue;
    }
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      // colspan/rowspan are real merge state (see TableCell/TableHeader's
      // own attributes in @tiptap/extension-table) — a plain positive
      // integer, capped defensively well above what a flashcard-sized table
      // could legitimately need, so a malformed/tampered value can't blow
      // up rendering with an absurd span.
      const MAX_SPAN = 100;
      const readSpan = (attr: string) => {
        const raw = el.getAttribute(attr);
        const n = raw !== null ? parseInt(raw, 10) : NaN;
        return Number.isFinite(n) && n >= 1 && n <= MAX_SPAN ? n : 1;
      };
      const colspan = readSpan('colspan');
      const rowspan = readSpan('rowspan');
      sanitizeNode(el);
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      if (colspan !== 1) el.setAttribute('colspan', String(colspan));
      if (rowspan !== 1) el.setAttribute('rowspan', String(rowspan));
      continue;
    }
    if (el.tagName === 'PRE') {
      // The only thing worth keeping inside a PRE is its CODE child's
      // language class (see the CODE branch below) — anything else in here
      // (a stray span, decoration markup some other source produced) isn't
      // real content, since CodeBlockLowlight's own highlighting is a
      // ProseMirror decoration, never part of getHTML()'s output in the
      // first place (see lib/tiptapBlockExtensions.ts's CodeBlock doc
      // comment) — so a real stored PRE only ever has one CODE child in
      // practice, but sanitizeNode still recurses generically to correctly
      // handle/strip whatever a pasted or tampered PRE might contain.
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      sanitizeNode(el);
      continue;
    }
    if (el.tagName === 'CODE') {
      // class is the only thing that matters: `language-<key>`, validated
      // against the exact same closed set the toolbar's picker offers (see
      // richTextModel.ts's CODE_BLOCK_LANGUAGES) — anything else is
      // meaningless (lowlight has nothing registered for it) and dropped,
      // same "closed set, not open-ended" rule as everything else here.
      // Marks (bold/italic/etc) inside a code block aren't part of this
      // schema's CodeBlock node (plain `text*` content, no marks) — Tiptap
      // itself would never produce them, but sanitizeNode still recurses to
      // correctly flatten/strip anything a pasted CODE block might contain
      // down to plain text.
      const cls = el.getAttribute('class');
      const language = cls?.match(/^language-([a-z0-9#+-]+)$/)?.[1];
      const validLanguage = language && ALLOWED_LANGUAGES.has(language) ? language : null;
      sanitizeNode(el);
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      if (validLanguage) el.setAttribute('class', `language-${validLanguage}`);
      continue;
    }
    // Checked before the generic SPAN/DIV handling below — an inline vs
    // block math node (see MathInline/MathBlock in
    // lib/tiptapBlockExtensions.ts) is a span/div purely because that's
    // this schema's inline/block leaf convention, not because it carries
    // any of SPAN's usual size/color/dim formatting or DIV's (currently
    // nonexistent) other meaning. Only the raw LaTeX *source* is ever
    // trusted from stored content — never rendered markup (KaTeX always
    // re-typesets it live, in TiptapFieldInput's MathNodeView and
    // RichText.tsx's own render effect) — capped defensively well past any
    // reasonable real equation, so a malformed/tampered value can't bloat
    // storage or make every re-render redo an absurd amount of KaTeX work.
    if ((el.tagName === 'SPAN' || el.tagName === 'DIV') && el.hasAttribute('data-latex')) {
      const MAX_LATEX_LENGTH = 4000;
      const latex = (el.getAttribute('data-latex') ?? '').slice(0, MAX_LATEX_LENGTH);
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      while (el.firstChild) el.removeChild(el.firstChild);
      el.setAttribute('data-latex', latex);
      el.setAttribute('contenteditable', 'false');
      if (el.tagName === 'DIV') el.setAttribute('data-display', 'block');
      continue;
    }
    // A DIV that isn't math has no meaning in this schema at all (no plain
    // "div" node type exists here) — unwrapped like any other tag Tiptap
    // itself could never have produced, rather than passed through
    // generically, so it can't smuggle unrecognized structure past
    // whatever DOMParser makes of the sanitized result.
    if (el.tagName === 'DIV') {
      unwrap(node, el);
      continue;
    }
    if (el.tagName === 'SPAN') {
      // A span only exists here to carry a size, color, and/or dim flag —
      // one with none of those is meaningless (e.g. pasted from elsewhere),
      // so unwrap it like any other disallowed content instead of leaving an empty
      // wrapper. EXCEPT: another legacy-data case from the old RichTextInput
      // (see the FONT branch above) — some engines (Safari, toggling bold/
      // italic/underline on a collapsed caret) implemented execCommand by
      // wrapping subsequently-typed text in a plain <span> with an inline
      // style instead of the semantic <b>/<i>/<u> tag used everywhere else.
      // Detecting that here and converting it to the semantic tag (rather
      // than unwrapping, which would silently discard the formatting)
      // keeps already-stored content from back then rendering correctly.
      const size = el.getAttribute('data-size');
      const validSize = size && ALLOWED_SIZES.has(size) ? size : null;
      const color = el.getAttribute('data-color');
      const validColor = color && ALLOWED_COLORS.has(color) ? color : null;
      // data-dim is a separate opacity-based de-emphasis effect, independent
      // of data-color — the rich text toolbar has a dedicated toggle for it.
      const dim = el.hasAttribute('data-dim');
      const fontWeight = el.style.fontWeight;
      const isBoldStyle = fontWeight === 'bold' || fontWeight === 'bolder' || parseInt(fontWeight, 10) >= 600;
      const fontStyle = el.style.fontStyle;
      const isItalicStyle = fontStyle === 'italic' || fontStyle === 'oblique';
      const textDecoration = el.style.textDecorationLine || el.style.textDecoration;
      const isUnderlineStyle = textDecoration.includes('underline');
      if (!validSize && !validColor && !dim && !isBoldStyle && !isItalicStyle && !isUnderlineStyle) {
        unwrap(node, el);
        continue;
      }
      sanitizeNode(el);
      if (isUnderlineStyle) wrapChildren(el, 'u');
      if (isItalicStyle) wrapChildren(el, 'i');
      if (isBoldStyle) wrapChildren(el, 'b');
      if (!validSize && !validColor && !dim) {
        // The span was purely a style-based formatting wrapper — now
        // redundant since that formatting just moved into a real semantic
        // tag above, so drop the empty span itself rather than leaving it
        // around as dead wrapping.
        while (el.firstChild) node.insertBefore(el.firstChild, el);
        node.removeChild(el);
        continue;
      }
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      if (validSize) el.setAttribute('data-size', validSize);
      if (validColor) el.setAttribute('data-color', validColor);
      if (dim) el.setAttribute('data-dim', '');
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
      // Read the label, the resize-handle width, and (AUDIO only) the trim
      // range before the attribute-clearing loop below removes them.
      const label = sanitizeLabel(el.tagName === 'IMG' ? el.getAttribute('alt') : el.getAttribute('title'));
      const widthRaw = el.getAttribute('data-width');
      const [minWidth, maxWidth] =
        el.tagName === 'IMG'
          ? [MIN_IMAGE_WIDTH_PERCENT, MAX_IMAGE_WIDTH_PERCENT]
          : [MIN_AUDIO_WIDTH_PERCENT, MAX_AUDIO_WIDTH_PERCENT];
      const width =
        widthRaw && /^\d+$/.test(widthRaw) ? Math.min(maxWidth, Math.max(minWidth, parseInt(widthRaw, 10))) : null;
      // A trim range only makes sense as a complete, ordered pair — a lone
      // start or end (or an end that doesn't come after its start) is
      // meaningless, so both are dropped together rather than trusting one
      // half of a malformed/tampered pair. No upper bound checked against
      // the real clip length here (sanitizeRichText has no way to know
      // it) — trim is pure playback metadata (see MediaAudio's own doc
      // comment in lib/tiptapExtensions.ts; the file itself is never cut),
      // so an over-long end value is harmless, just clamped by whatever
      // actually renders/plays it at the real duration.
      let trimStart: number | null = null;
      let trimEnd: number | null = null;
      if (el.tagName === 'AUDIO') {
        const startRaw = el.getAttribute('data-trim-start');
        const endRaw = el.getAttribute('data-trim-end');
        const start = startRaw !== null ? Number(startRaw) : NaN;
        const end = endRaw !== null ? Number(endRaw) : NaN;
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
          trimStart = start;
          trimEnd = end;
        }
      }
      // Same "a partial/nonsensical set is meaningless, drop the whole
      // thing" rule as trim above — a crop rectangle only makes sense with
      // all four fractions present, in [0,1], with positive width/height,
      // and not extending past the original image's own edge.
      let cropX: number | null = null;
      let cropY: number | null = null;
      let cropWidth: number | null = null;
      let cropHeight: number | null = null;
      if (el.tagName === 'IMG') {
        const inRange = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
        const readFraction = (attr: string) => {
          const raw = el.getAttribute(attr);
          return raw !== null ? Number(raw) : NaN;
        };
        const x = readFraction('data-crop-x');
        const y = readFraction('data-crop-y');
        const w = readFraction('data-crop-w');
        const h = readFraction('data-crop-h');
        if (inRange(x) && inRange(y) && inRange(w) && inRange(h) && w > 0 && h > 0 && x + w <= 1.001 && y + h <= 1.001) {
          cropX = x;
          cropY = y;
          cropWidth = w;
          cropHeight = h;
        }
      }
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
      // Reconstructed from the already-clamped number above, never copied
      // from the attacker-controlled style string itself — same "we build
      // the value, we don't trust theirs" rule as `src` above.
      if (width) {
        el.setAttribute('data-width', String(width));
        el.setAttribute('style', `width: ${width}%`);
      }
      if (el.tagName === 'IMG') {
        el.setAttribute('alt', label);
        if (cropX !== null && cropY !== null && cropWidth !== null && cropHeight !== null) {
          el.setAttribute('data-crop-x', String(cropX));
          el.setAttribute('data-crop-y', String(cropY));
          el.setAttribute('data-crop-w', String(cropWidth));
          el.setAttribute('data-crop-h', String(cropHeight));
        }
      }
      // controls (and never autoplay) is forced unconditionally on AUDIO so
      // stored content can never render as an invisible or self-playing
      // element regardless of what produced the HTML.
      if (el.tagName === 'AUDIO') {
        el.setAttribute('controls', '');
        el.setAttribute('title', label);
        if (trimStart !== null && trimEnd !== null) {
          el.setAttribute('data-trim-start', String(trimStart));
          el.setAttribute('data-trim-end', String(trimEnd));
        }
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
