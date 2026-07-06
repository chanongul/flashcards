import { db, type Card, type PendingMedia } from './db';
import { editCard } from './actions';

const PENDING_ID_RE = /pending:([0-9a-f-]{36})/g;

function extractPendingIds(html: string): string[] {
  const ids = new Set<string>();
  const re = new RegExp(PENDING_ID_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.add(m[1]);
  return Array.from(ids);
}

async function uploadPendingItem(item: PendingMedia): Promise<string> {
  const formData = new FormData();
  formData.append('file', item.blob);
  const res = await fetch(`/api/media/upload/${item.kind}`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error('upload failed');
  const { filename } = await res.json();
  return filename;
}

function cardContainsMarker(card: Card, marker: string): boolean {
  return (
    card.front.includes(marker) ||
    card.back.includes(marker) ||
    Object.values(card.fields).some((v) => v.includes(marker))
  );
}

// Rewrites every note referencing a just-uploaded pending marker to the real
// filename. Grouped by noteId, not card.id — a reversed sibling or
// multi-field custom note shares one note, and editing each derived card row
// separately would just be redundant/conflicting event-log writes for the
// same underlying content (same pattern already used for delete/clone in
// lib/actions.ts). The rewritten HTML has no `src` for the new filename yet
// — that's fine, RichText/RichTextInput regenerate it from data-media-id on
// their next sanitize pass, same as any other stored media reference.
async function replacePendingReferences(userId: string, pendingId: string, filename: string) {
  const marker = `pending:${pendingId}`;
  const cards = await db.cards.filter((c) => !c.deleted && cardContainsMarker(c, marker)).toArray();
  const noteIds = new Set(cards.map((c) => c.noteId));

  for (const noteId of noteIds) {
    const card = cards.find((c) => c.noteId === noteId);
    if (!card) continue;

    const changes: { front?: string; back?: string; fields?: Record<string, string> } = {};
    if (card.front.includes(marker)) changes.front = card.front.replaceAll(marker, filename);
    if (card.back.includes(marker)) changes.back = card.back.replaceAll(marker, filename);
    if (Object.values(card.fields).some((v) => v.includes(marker))) {
      changes.fields = Object.fromEntries(
        Object.entries(card.fields).map(([key, val]) => [
          key,
          val.includes(marker) ? val.replaceAll(marker, filename) : val,
        ])
      );
    }
    await editCard(userId, noteId, changes);
  }
}

/** Called at submit time (card create/edit) — uploads any pending:{id}
 * placeholders still in this HTML and rewrites them to the real filename.
 * A marker that uploads successfully is fully resolved right here: its
 * pendingMedia row is deleted immediately, nothing needs to touch it again.
 * A marker that fails to upload (offline, transient error) is left in
 * place, and its row is marked `committed` — the field content about to be
 * saved still has the "pending:" marker in it, so the background sync (see
 * syncPendingMedia) now knows it's safe to retry later. */
export async function resolvePendingMediaInHtml(html: string): Promise<string> {
  let result = html;
  for (const id of extractPendingIds(html)) {
    const row = await db.pendingMedia.get(id);
    if (!row) continue;
    try {
      const filename = await uploadPendingItem(row);
      result = result.replaceAll(`pending:${id}`, filename);
      await db.pendingMedia.delete(id);
    } catch {
      await db.pendingMedia.update(id, { committed: true });
    }
  }
  return result;
}

/** Retries every committed-but-still-unresolved pending upload (see
 * lib/db.ts's PendingMedia.committed). Deliberately ignores uncommitted
 * rows — those are still only referenced by an open, unsaved editor (see
 * resolvePendingMediaInHtml), and uploading one here would race with that
 * editor's own submit-time resolve: the file could get uploaded and this
 * row deleted before the card is ever saved, leaving a "pending:" marker
 * nothing will ever resolve. Called from SyncManager on its existing
 * interval/focus ticks plus the `online` listener; a no-op while offline. */
export async function syncPendingMedia(userId: string) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  const pending = await db.pendingMedia.toArray();
  for (const item of pending) {
    if (!item.committed) continue;
    try {
      const filename = await uploadPendingItem(item);
      await replacePendingReferences(userId, item.id, filename);
      await db.pendingMedia.delete(item.id);
    } catch {
      // Still offline, or a transient failure — leave it queued.
    }
  }
}
