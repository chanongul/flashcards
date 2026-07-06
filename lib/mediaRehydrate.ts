import { db } from './db';

// A "pending:{id}" media element (queued locally while offline — see
// lib/db.ts's PendingMedia and lib/mediaSync.ts) has no real `src` yet.
// Fills one in from the locally-stored blob so the image/audio is still
// visible/playable before it's actually uploaded. Shared between RichText
// (review-time rendering) and RichTextInput (editing) since both need it.
// Returns a cleanup function that revokes the object URLs it created.
export function rehydratePendingMedia(container: HTMLElement): () => void {
  const urls: string[] = [];
  let cancelled = false;

  (async () => {
    const pendingEls = Array.from(
      container.querySelectorAll<HTMLElement>('[data-media-id^="pending:"]')
    ).filter((el) => !el.getAttribute('src'));

    for (const el of pendingEls) {
      const id = el.getAttribute('data-media-id')!.slice('pending:'.length);
      const row = await db.pendingMedia.get(id);
      if (cancelled || !row) continue;
      const url = URL.createObjectURL(row.blob);
      urls.push(url);
      el.setAttribute('src', url);
    }
  })();

  return () => {
    cancelled = true;
    urls.forEach((url) => URL.revokeObjectURL(url));
  };
}
