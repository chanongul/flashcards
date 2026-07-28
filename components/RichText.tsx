'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { sanitizeRichText } from '@/lib/sanitize';
import { rehydratePendingMedia } from '@/lib/mediaRehydrate';
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

// Sanitizes again at render time (defense in depth) even though input is
// already sanitized on save — cheap, and protects against any stored value
// that bypassed that step (old data, a future different client, etc.).
export function RichText({ html, className, textTransform }: RichTextProps) {
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
    }
  }, [sanitized, textTransform]);

  useIsomorphicLayoutEffect(() => {
    if (!ref.current) return;
    return rehydratePendingMedia(ref.current);
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
