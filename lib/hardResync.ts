import { db } from './db';
import { pushEvents, pullAndReplay } from './sync';
import { syncPendingMedia } from './mediaSync';

export type HardResyncFailureReason = 'offline' | 'unsynced';

export interface HardResyncResult {
  ok: boolean;
  reason?: HardResyncFailureReason;
}

/** Wipes every local table and rebuilds entirely fresh from Supabase — a
 * cache-clearing "hard resync," NOT a data-destroying reset (contrast
 * resetAllData in lib/sync.ts, which deletes the user's actual content
 * everywhere via a full_reset tombstone). Only ever touches this device's
 * local IndexedDB; Supabase itself is never written to, only re-read from.
 *
 * Refuses to run unless everything local is already confirmed pushed/
 * uploaded — a local wipe would otherwise silently discard anything that
 * only ever existed on this device (an offline review, a queued-but-not-
 * yet-uploaded image). Pushing/uploading is attempted here, but success is
 * verified by re-checking the tables afterward rather than trusting that
 * the attempt didn't throw — pushEvents/syncPendingMedia both swallow
 * individual failures internally instead of throwing, so a resolved
 * promise alone doesn't mean everything actually made it. */
export async function hardResync(userId: string): Promise<HardResyncResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, reason: 'offline' };
  }

  await pushEvents();
  await syncPendingMedia(userId);

  // Only `committed` rows represent media that's confirmed queued-and-
  // retriable (see lib/mediaSync.ts) — a `committed: false` row is either
  // still referenced by a genuinely open, unsaved editor elsewhere, or (far
  // more likely here) an orphan left behind by attaching an image/audio to
  // a card draft that was cancelled instead of submitted — there's no
  // cleanup path for that anywhere, so such a row can sit forever.
  // syncPendingMedia deliberately never retries it (retrying mid-edit would
  // race the editor's own save), so it can never resolve on its own —
  // counting it here would block every future resync permanently rather
  // than just once. The wipe below clears it regardless of committed state.
  const [unsyncedCount, committedPendingCount] = await Promise.all([
    db.events.filter((e) => !e.synced).count(),
    db.pendingMedia.filter((m) => m.committed).count(),
  ]);
  if (unsyncedCount > 0 || committedPendingCount > 0) {
    return { ok: false, reason: 'unsynced' };
  }

  await db.decks.clear();
  await db.cards.clear();
  await db.noteTypes.clear();
  await db.events.clear();
  await db.pendingMedia.clear();

  await pullAndReplay(userId);
  return { ok: true };
}
