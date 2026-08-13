import { db } from './db';

// A "pending:{id}" media element (queued locally while offline — see
// lib/db.ts's PendingMedia and lib/mediaSync.ts) has no real `src` yet.
// Fills one in from the locally-stored blob so the image/audio is still
// visible/playable before it's actually uploaded. Used by RichText
// (review-time rendering of a card's front/back) and by TiptapFieldInput
// (reopening a field whose value already contains a pending reference from
// an earlier, still-offline session — a freshly inserted one sets its own
// live src immediately instead, see TiptapFieldInput's insertImage/
// insertAudio). Returns a cleanup function that revokes the object URLs it
// created.
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
