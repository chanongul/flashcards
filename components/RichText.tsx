'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { sanitizeRichText } from '@/lib/sanitize';
import { rehydratePendingMedia } from '@/lib/mediaRehydrate';
import { useLoading } from './GlobalLoading';

interface RichTextProps {
  html: string;
  className?: string;
}

// useLayoutEffect does nothing (and warns) during SSR — fall back to
// useEffect there; on the client this still runs before paint, so there's no
// flash of empty content on first mount.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Sanitizes again at render time (defense in depth) even though input is
// already sanitized on save — cheap, and protects against any stored value
// that bypassed that step (old data, a future different client, etc.).
export function RichText({ html, className }: RichTextProps) {
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
    }
  }, [sanitized]);

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

    begin();
    let released = false;
    let remaining = pending.length;
    const release = () => {
      if (released) return;
      released = true;
      end();
    };
    const onSettled = () => {
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
    // leave the bar on indefinitely.
    const timeout = setTimeout(release, 5000);

    return () => {
      clearTimeout(timeout);
      release();
      pending.forEach((m) => {
        m.removeEventListener('load', onSettled);
        m.removeEventListener('loadeddata', onSettled);
        m.removeEventListener('error', onSettled);
      });
    };
  }, [sanitized, begin, end]);

  return <span ref={ref} className={`rich-text-content ${className ?? ''}`} />;
}
