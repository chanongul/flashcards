'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import katex from 'katex';
import type { Element as HastElement, Root as HastRoot } from 'hast';
import { sanitizeRichText } from '@/lib/sanitize';
import { rehydratePendingMedia } from '@/lib/mediaRehydrate';
import { resolveMediaSrcById } from './MediaShared';
import { trimAudioBlobForPreview } from '@/lib/trimAudioPreview';
import { lowlight } from '@/lib/tiptapBlockExtensions';
import { attachTableFade } from '@/lib/tableFade';
import { useLoading } from './GlobalLoading';

interface RichTextProps {
  html: string;
  className?: string;
  // Applied to every text node after (re)writing innerHTML — e.g. CardFaces
  // passes lib/arrowify's arrowify to turn "->" into "→" for review/preview
  // display only, never touching what's actually stored. Operates on real
  // DOM text nodes rather than the HTML string itself, since sanitizeRichText
  // entity-encodes ">" in text content (a plain string replace on the raw
  // HTML would silently never match).
  textTransform?: (text: string) => string;
  // Shows each image/audio's required label (alt/title — see
  // MediaFieldInput's extractMediaLabel) as a small dimmed caption right
  // below it — CardFaces passes this for review/preview display; the
  // editing forms already show the same label as an editable input, so
  // showing it again there would just be a redundant duplicate.
  showMediaCaption?: boolean;
}

// useLayoutEffect does nothing (and warns) during SSR — fall back to
// useEffect there; on the client this still runs before paint, so there's no
// flash of empty content on first mount.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function applyTextTransform(root: HTMLElement, transform: (text: string) => string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const next = transform(text.data);
    if (next !== text.data) text.data = next;
    node = walker.nextNode();
  }
}

function addMediaCaptions(root: HTMLElement) {
  const media = root.querySelectorAll<HTMLImageElement | HTMLAudioElement>('img[alt], audio[title]');
  media.forEach((el) => {
    const label = el instanceof HTMLImageElement ? el.getAttribute('alt') : el.getAttribute('title');
    if (!label || !label.trim()) return;
    const caption = document.createElement('span');
    caption.textContent = label;
    caption.className = 'mt-0.5 block text-xs text-neutral-500';
    el.insertAdjacentElement('afterend', caption);
  });
}

// Sanitizes again at render time (defense in depth) even though input is
// already sanitized on save — cheap, and protects against any stored value
// that bypassed that step (old data, a future different client, etc.).
export function RichText({ html, className, textTransform, showMediaCaption }: RichTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const sanitized = sanitizeRichText(html);
  const { begin, end } = useLoading();

  // Synced manually rather than via React's dangerouslySetInnerHTML prop —
  // React re-applies innerHTML on every render regardless of whether the
  // string value actually changed (verified: the effect below correctly
  // skips when `sanitized` is unchanged, but the DOM's innerHTML still gets
  // torn down and recreated on an unrelated re-render). That silently wiped
  // the `src` the rehydration effect had already set on a pending media
  // element any time some completely unrelated sibling re-rendered this
  // component — e.g. opening a crop dialog elsewhere in the same field.
  useIsomorphicLayoutEffect(() => {
    if (ref.current && ref.current.innerHTML !== sanitized) {
      ref.current.innerHTML = sanitized;
      if (textTransform) applyTextTransform(ref.current, textTransform);
      if (showMediaCaption) addMediaCaptions(ref.current);
    }
  }, [sanitized, textTransform, showMediaCaption]);

  useIsomorphicLayoutEffect(() => {
    if (!ref.current) return;
    return rehydratePendingMedia(ref.current);
  }, [sanitized]);

  // Wraps every table in a div.tableWrapper — sanitizeRichText only ever
  // stores a bare <table>, with none of the scroll-containing structure
  // Tiptap's own live-editor NodeView automatically wraps it in (also
  // class="tableWrapper", not a coincidence — see globals.css's own rule
  // for why this needs to match exactly: one CSS rule covers both this
  // read-only display and the live editor). Without it, a table wider than
  // the field (one long unbroken word forcing a column wider, or just
  // enough columns) breaks out of the field's own box entirely instead of
  // scrolling within it.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tables = Array.from(el.querySelectorAll<HTMLTableElement>('table'));
    const cleanups: Array<() => void> = [];
    tables.forEach((table) => {
      let wrapper = table.parentElement;
      if (!wrapper?.classList.contains('tableWrapper')) {
        wrapper = document.createElement('div');
        wrapper.className = 'tableWrapper';
        table.replaceWith(wrapper);
        wrapper.appendChild(table);
      }
      // See lib/tableFade.ts's own doc comment for why this needs to be a
      // real overlay rather than .tableWrapper's own CSS-only fade.
      cleanups.push(attachTableFade(wrapper));
    });
    return () => cleanups.forEach((fn) => fn());
  }, [sanitized]);

  // Crop is pure display metadata, never applied to the actual file (see
  // MediaImage's own cropX/Y/Width/Height doc comment in
  // lib/tiptapExtensions.ts) — sanitizeRichText only ever stores a crop
  // rectangle as data-crop-x/y/w/h on a plain <img> whose src always points
  // at the full original, so without this a review card would show the
  // whole original instead of just the cropped rectangle — the same bug
  // already fixed for audio trim above, here for image crop. Mirrors
  // ImageNodeView's JSX in TiptapFieldInput.tsx exactly (same wrapper/
  // positioning math, see that component for the underlying algebra) but
  // built imperatively since this renders raw sanitized HTML rather than
  // React elements: wraps each cropped <img> in a new overflow-hidden span
  // aspect-ratio'd to the crop rectangle's own pixel proportions, then
  // scales/shifts the img inside it. The resize width (data-width/style,
  // if any) has to move from the img onto this new wrapper — the img's own
  // style becomes entirely crop-derived — since sanitizeRichText has no
  // concept of a wrapper and puts both concerns on the same element.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const imgs = Array.from(
      el.querySelectorAll<HTMLImageElement>('img[data-crop-x][data-crop-y][data-crop-w][data-crop-h]')
    );
    if (imgs.length === 0) return;

    const removeListeners: Array<() => void> = [];

    imgs.forEach((img) => {
      const cropX = Number(img.getAttribute('data-crop-x'));
      const cropY = Number(img.getAttribute('data-crop-y'));
      const cropWidth = Number(img.getAttribute('data-crop-w'));
      const cropHeight = Number(img.getAttribute('data-crop-h'));
      if (
        ![cropX, cropY, cropWidth, cropHeight].every(Number.isFinite) ||
        cropWidth <= 0 ||
        cropHeight <= 0
      ) {
        return;
      }

      // Same "defaults to filling the field, no natural size of its own"
      // rule as ImageNodeView's own `width` fallback — a crop is a subset
      // of the original, not a whole image with an intrinsic display size.
      const widthRaw = img.getAttribute('data-width');
      const resizeWidth = widthRaw && /^\d+$/.test(widthRaw) ? parseInt(widthRaw, 10) : 100;

      const wrapper = document.createElement('span');
      wrapper.className = 'relative block overflow-hidden';
      wrapper.style.width = `${resizeWidth}%`;
      // Plain fraction ratio until the image actually loads and the real
      // natural-pixel proportions are known (self-corrects below) — see
      // ImageNodeView's own comment on why the fraction ratio alone is
      // only a placeholder, not generally correct.
      wrapper.style.aspectRatio = `${cropWidth} / ${cropHeight}`;

      img.replaceWith(wrapper);
      wrapper.appendChild(img);

      img.removeAttribute('style');
      img.style.position = 'absolute';
      img.style.width = `${100 / cropWidth}%`;
      img.style.height = 'auto';
      img.style.left = `${-(cropX / cropWidth) * 100}%`;
      img.style.top = `${-(cropY / cropHeight) * 100}%`;
      // Overrides globals.css's `.rich-text-content img { max-width: 100% }`
      // — see ImageNodeView's identical override for why.
      img.style.maxWidth = 'none';

      const applyAspect = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          wrapper.style.aspectRatio = `${cropWidth * img.naturalWidth} / ${cropHeight * img.naturalHeight}`;
        }
      };
      // Not gated on img.complete — a still-pending upload's img has no src
      // yet at the point this effect runs (rehydratePendingMedia, the
      // effect above, fills it in asynchronously), and a src-less <img> is
      // trivially "complete" with naturalWidth 0, which would wrongly skip
      // straight past applyAspect and never register the listener that's
      // needed once the real src actually loads. Always listen; also apply
      // immediately for the case where the image (an already-uploaded
      // src="/api/media/...") happens to be genuinely already loaded.
      if (img.naturalWidth > 0 && img.naturalHeight > 0) applyAspect();
      img.addEventListener('load', applyAspect, { once: true });
      removeListeners.push(() => img.removeEventListener('load', applyAspect));
    });

    return () => removeListeners.forEach((fn) => fn());
  }, [sanitized]);

  // Trim is pure playback metadata, never applied to the actual file (see
  // MediaAudio's own doc comment in lib/tiptapExtensions.ts) — the audio
  // element's own `src`, whichever this card's is, always points at the
  // full original. Without this, a trimmed clip would show/play the entire
  // original on a review card, ignoring the trim entirely — the same bug
  // already fixed for the live editor (TiptapFieldInput's AudioNodeView),
  // here for the read-only display. Resolves `src` itself, independently,
  // via resolveMediaSrcById — rather than reading whatever the
  // rehydratePendingMedia effect above set — since that effect is its own
  // async IIFE with no ordering guarantee relative to this one; this one's
  // own (necessarily slower — it also fetches+decodes+re-encodes on top of
  // the same lookup) resolution finishing later is what makes it the one
  // that actually wins for a still-pending, still-trimmed clip.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const audios = Array.from(
      el.querySelectorAll<HTMLAudioElement>('audio[data-media-id][data-trim-start][data-trim-end]')
    );
    if (audios.length === 0) return;
    let cancelled = false;
    const urls: string[] = [];
    audios.forEach((audio) => {
      const mediaId = audio.getAttribute('data-media-id');
      const start = Number(audio.getAttribute('data-trim-start'));
      const end = Number(audio.getAttribute('data-trim-end'));
      if (!mediaId || !Number.isFinite(start) || !Number.isFinite(end)) return;
      void (async () => {
        try {
          const src = await resolveMediaSrcById(mediaId);
          if (!src || cancelled) return;
          const original = await (await fetch(src)).blob();
          const trimmed = await trimAudioBlobForPreview(original, start, end);
          if (cancelled) return;
          const url = URL.createObjectURL(trimmed);
          urls.push(url);
          audio.src = url;
        } catch {
          // Cosmetic-only best effort — leave whatever src rehydration/
          // sanitizeRichText already produced in place.
        }
      })();
    });
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [sanitized]);

  // Recursively turns a lowlight/hast node into real DOM nodes — the
  // "hljs-*" token spans lowlight produces are a plain JS tree (hast), not
  // an HTML string, so they need converting rather than just setting
  // innerHTML (see lib/tiptapBlockExtensions.ts's own CodeBlock doc comment
  // for why lowlight returns a tree in the first place).
  function appendHast(node: HastRoot | HastElement, parent: Node) {
    for (const child of node.children) {
      if (child.type === 'text') {
        parent.appendChild(document.createTextNode(child.value));
      } else if (child.type === 'element') {
        const el = document.createElement(child.tagName);
        const className = child.properties?.className;
        if (Array.isArray(className)) el.className = className.join(' ');
        appendHast(child, el);
        parent.appendChild(el);
      }
    }
  }

  // CodeBlockLowlight's own syntax-highlight spans are a ProseMirror
  // decoration, painted live over the editor's text but never part of
  // getHTML()'s serialized output (see lib/tiptapBlockExtensions.ts's own
  // CodeBlock doc comment) — sanitizeRichText only ever stores the plain
  // code text plus a `language-*` class, so without this a review card
  // would show unhighlighted code even though the editor showed it
  // highlighted. Re-derives the exact same decorations from the same
  // `lowlight` instance the editor itself uses, so this can only ever
  // highlight what the editor could have produced.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const blocks = Array.from(el.querySelectorAll<HTMLElement>('pre > code[class^="language-"]'));
    blocks.forEach((code) => {
      const language = code.className.replace(/^language-/, '');
      const text = code.textContent ?? '';
      if (!lowlight.registered(language)) return;
      const tree = lowlight.highlight(language, text);
      code.textContent = '';
      appendHast(tree, code);
    });
  }, [sanitized]);

  // Same "attrs are the source of truth, actually typesetting it is the
  // render layer's job" pattern as the code-highlight effect just above —
  // sanitizeRichText only ever stores a math node's raw LaTeX *source* (see
  // MathInline/MathBlock's own doc comment in lib/tiptapBlockExtensions.ts),
  // never rendered markup, so it has to be typeset here too, independently
  // of TiptapFieldInput's own MathNodeView. throwOnError: false — see
  // MathEditModal's identical option for why (a malformed/tampered source
  // renders as KaTeX's own inline error text rather than crashing this
  // display).
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-latex]'));
    nodes.forEach((node) => {
      const latex = node.getAttribute('data-latex') ?? '';
      if (!latex.trim()) return;
      try {
        katex.render(latex, node, { throwOnError: false, displayMode: node.tagName === 'DIV', output: 'html' });
      } catch {
        node.textContent = latex;
      }
    });
  }, [sanitized]);

  // Shows the global loading bar while this field's own images/audio are
  // still fetching from the server — otherwise a slow connection makes them
  // pop in with no feedback at all. Only tracks media with a real
  // /api/media/ src already baked in by sanitizeRichText (i.e. already-
  // uploaded content) — a still-pending upload's preview is a local blob
  // URL (see rehydratePendingMedia above), which loads instantly and isn't
  // worth signaling.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const media = Array.from(
      el.querySelectorAll<HTMLImageElement | HTMLAudioElement>('img[src], audio[src]')
    );
    const pending = media.filter((m) =>
      m instanceof HTMLImageElement ? !m.complete : m.readyState === 0
    );
    if (pending.length === 0) return;

    // See globals.css's media-skeleton-pulse rule — a shimmer placeholder
    // shown for exactly as long as this same element counts toward the
    // loading bar above, cleared by the same load/loadeddata/error settle.
    pending.forEach((m) => m.classList.add('media-loading'));

    begin();
    let released = false;
    let remaining = pending.length;
    const release = () => {
      if (released) return;
      released = true;
      end();
    };
    const onSettled = (e: Event) => {
      (e.currentTarget as HTMLImageElement | HTMLAudioElement).classList.remove('media-loading');
      remaining -= 1;
      if (remaining <= 0) release();
    };
    pending.forEach((m) => {
      m.addEventListener('load', onSettled);
      m.addEventListener('loadeddata', onSettled);
      m.addEventListener('error', onSettled);
    });
    // Safety net: some browsers defer loading an <audio> element's data
    // until playback starts regardless of `preload`, which would otherwise
    // leave the bar (and the skeleton) on indefinitely.
    const timeout = setTimeout(() => {
      pending.forEach((m) => m.classList.remove('media-loading'));
      release();
    }, 5000);

    return () => {
      clearTimeout(timeout);
      release();
      pending.forEach((m) => {
        m.classList.remove('media-loading');
        m.removeEventListener('load', onSettled);
        m.removeEventListener('loadeddata', onSettled);
        m.removeEventListener('error', onSettled);
      });
    };
  }, [sanitized, begin, end]);

  return <span ref={ref} className={`rich-text-content ${className ?? ''}`} />;
}
