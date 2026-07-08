import {
  db,
  type ReviewEvent,
  type Card,
  type Deck,
  type Note,
  type NoteType,
  DEFAULT_NEW_CARDS_PER_DAY,
  DEFAULT_REVIEWS_PER_DAY,
} from './db';
import { createClient } from '@/utils/supabase/client';
import { newFsrsState, schedule, type Grade } from './fsrs';
import { clozeNumbers } from './cloze';
import { cleanupBrs } from './sanitize';

const supabase = createClient();

// A stable per-browser-install id, used to identify which device wrote an event.
// Not a security identifier — just useful for debugging sync issues.
function getClientId(): string {
  const key = 'flashcard_client_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export async function logEvent(
  userId: string,
  entityId: string,
  type: ReviewEvent['type'],
  payload: Record<string, unknown>
) {
  const event: ReviewEvent = {
    id: crypto.randomUUID(),
    userId,
    entityId,
    type,
    payload,
    clientId: getClientId(),
    timestamp: Date.now(),
    synced: false,
  };
  await db.events.add(event);
  return event;
}

/** Push any local events that haven't been synced yet. Safe to call often.
 * Inserted one at a time (not batched) so a single rejected row — bad data,
 * a transient conflict, whatever — can't wedge every other event queued
 * behind it forever; each row is retried independently on the next call. */
export async function pushEvents() {
  const unsynced = await db.events.filter((e) => !e.synced).toArray();
  if (unsynced.length === 0) return { pushed: 0 };

  let pushed = 0;
  let lastError: unknown;

  for (const e of unsynced) {
    const { error } = await supabase.from('events').insert({
      id: e.id,
      user_id: e.userId,
      entity_id: e.entityId,
      type: e.type,
      payload: e.payload,
      client_id: e.clientId,
      timestamp: e.timestamp,
    });

    if (error) {
      console.error('pushEvents: failed to push event', e.id, e.type, error);
      lastError = error;
      continue;
    }

    await db.events.update(e.id, { synced: true });
    pushed++;
  }

  const failed = unsynced.length - pushed;
  return failed > 0 ? { pushed, failed, error: lastError } : { pushed };
}

/** Permanently wipes every deck, card, note type, and review event —
 * everywhere, not just this device. Deleting this device's local tables and
 * the server-side log alone isn't enough: any *other* device signed into
 * the same account still has its own full local copy sitting in IndexedDB,
 * completely untouched, and pullAndReplay only ever adds events a device is
 * missing — it never removes ones a device already has. Left alone, that
 * other device would just go on showing (and even re-syncing) all the old
 * data forever, oblivious to the reset.
 *
 * So this pushes a `full_reset` tombstone through the normal event log
 * instead of only deleting out-of-band. Every device that ever pulls it
 * (including this one, on its very next sync) has replayAllEvents ignore
 * everything at or before its timestamp — see the resetCutoff logic there.
 * Old rows are also deleted server-side (and the equivalent old rows
 * dropped locally here) for real cleanup, but that part is just tidiness;
 * the tombstone is what actually makes the reset reach every device.
 * Irreversible — there's no soft-delete/undo path for this, unlike every
 * other destructive action in the app. */
export async function resetAllData(userId: string) {
  const event = await logEvent(userId, userId, 'full_reset', {});
  const { error } = await supabase.from('events').insert({
    id: event.id,
    user_id: event.userId,
    entity_id: event.entityId,
    type: event.type,
    payload: event.payload,
    client_id: event.clientId,
    timestamp: event.timestamp,
  });
  if (error) throw error;
  await db.events.update(event.id, { synced: true });

  const { error: deleteError } = await supabase
    .from('events')
    .delete()
    .eq('user_id', userId)
    .lt('timestamp', event.timestamp);
  if (deleteError) throw deleteError;

  await db.pendingMedia.clear();
  await db.events.where('timestamp').below(event.timestamp).delete();
  await replayAllEvents();
}

/** Pull any remote events we don't have locally yet, then replay them. */
export async function pullAndReplay(userId: string) {
  const localIds = new Set((await db.events.toArray()).map((e) => e.id));

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('user_id', userId)
    .order('timestamp', { ascending: true });

  if (error) {
    console.error('pullAndReplay fetch failed', error);
    return { pulled: 0, error };
  }

  const newEvents = (data ?? []).filter((row) => !localIds.has(row.id));
  if (newEvents.length === 0) return { pulled: 0 };

  await db.events.bulkPut(
    newEvents.map((row) => ({
      id: row.id,
      userId: row.user_id,
      entityId: row.entity_id,
      type: row.type,
      payload: row.payload,
      clientId: row.client_id,
      timestamp: row.timestamp,
      synced: true,
    }))
  );

  await replayAllEvents();
  return { pulled: newEvents.length };
}

/**
 * Rebuilds the decks/cards/noteTypes tables from scratch by replaying the full
 * event log in timestamp order. This is what makes sync conflicts mostly
 * resolve themselves — instead of merging "current state," every device
 * arrives at the same state by replaying the same facts in the same order.
 *
 * Cards are a *derived* materialization of Notes, computed fresh every replay
 * (see lib/db.ts's Note/Card doc comments for why). This runs in three passes:
 *   1. Fold deck_create/edit/delete, notetype_create/edit/delete, and
 *      card_create/edit/delete into decks, note types, and notes (content
 *      only — front/back/fields/tags/deckId/cardType).
 *   2. Derive cards from notes: one per basic/custom note (id == noteId, so
 *      every pre-existing card keeps its exact identity) — plus a second
 *      back->front sibling (id == `${noteId}::reversed`) when a basic note
 *      has `reversed: true` — or one per distinct {{cN::...}} number for
 *      cloze notes (id == `${noteId}::${n}`). Custom-type cards get their
 *      front/back rendered from the note's `fields` using that note type's
 *      questionFields/answerFields.
 *   3. Re-walk the events applying card-level facts — card_review/undo and the
 *      flagged/suspended/isLeech subset of card_edit — keyed by the derived
 *      card id from pass 2. This makes flag/suspend actions on an old-style
 *      (pre-multi-cloze) event a no-op for cloze cards, since old events use
 *      the bare noteId as entityId, which no cloze card id equals anymore.
 */
export async function replayAllEvents() {
  const allEvents = await db.events.orderBy('timestamp').toArray();

  // A full_reset tombstone means "ignore everything up to here" — for every
  // device, not just the one that created it, since it propagates through
  // the same push/pull as any other event. Without this, a device that
  // still has its own pre-reset events sitting locally (never told to
  // remove them — pullAndReplay only ever adds events it's missing) would
  // just keep deriving decks/cards/noteTypes from them forever, completely
  // unaffected by a reset that happened elsewhere. See resetAllData.
  const resetTimestamps = allEvents.filter((e) => e.type === 'full_reset').map((e) => e.timestamp);
  const resetCutoff = resetTimestamps.length > 0 ? Math.max(...resetTimestamps) : null;
  const events = resetCutoff === null ? allEvents : allEvents.filter((e) => e.timestamp > resetCutoff);

  const undoneReviewIds = new Set(
    events
      .filter((e) => e.type === 'card_review_undo')
      .map((e) => e.payload.undoneEventId as string)
  );

  const decks = new Map<string, Deck>();
  const noteTypes = new Map<string, NoteType>();
  const notes = new Map<string, Note>();

  for (const e of events) {
    switch (e.type) {
      case 'deck_create':
      case 'deck_edit': {
        const p = e.payload as Partial<Deck>;
        const existing = decks.get(e.entityId);
        decks.set(e.entityId, {
          id: e.entityId,
          name: (p.name as string) ?? existing?.name ?? 'Untitled deck',
          newCardsPerDay: (p.newCardsPerDay as number) ?? existing?.newCardsPerDay ?? DEFAULT_NEW_CARDS_PER_DAY,
          reviewsPerDay: (p.reviewsPerDay as number) ?? existing?.reviewsPerDay ?? DEFAULT_REVIEWS_PER_DAY,
          // Never revived by an edit — only a dedicated deck_delete event (or
          // its absence) determines this, same as notes/cards below.
          deleted: existing?.deleted ?? false,
          createdAt: existing?.createdAt ?? e.timestamp,
          updatedAt: e.timestamp,
        });
        break;
      }
      case 'deck_delete': {
        const existing = decks.get(e.entityId);
        if (existing) decks.set(e.entityId, { ...existing, deleted: true, updatedAt: e.timestamp });
        break;
      }
      case 'notetype_create':
      case 'notetype_edit': {
        const p = e.payload as Partial<NoteType>;
        const existing = noteTypes.get(e.entityId);
        noteTypes.set(e.entityId, {
          id: e.entityId,
          name: p.name ?? existing?.name ?? 'Untitled type',
          fields: p.fields ?? existing?.fields ?? [],
          questionFields: p.questionFields ?? existing?.questionFields ?? [],
          answerFields: p.answerFields ?? existing?.answerFields ?? [],
          fieldTypes: p.fieldTypes ?? existing?.fieldTypes ?? {},
          fieldChoices: p.fieldChoices ?? existing?.fieldChoices ?? {},
          fieldTemplates: p.fieldTemplates ?? existing?.fieldTemplates ?? {},
          reversed: p.reversed ?? existing?.reversed ?? false,
          // Was hardcoded `false` — meaning any edit event silently revived a
          // deleted note type regardless of replay order. Preserve it like
          // every other field instead.
          deleted: existing?.deleted ?? false,
          createdAt: existing?.createdAt ?? e.timestamp,
          updatedAt: e.timestamp,
        });
        break;
      }
      case 'notetype_delete': {
        const existing = noteTypes.get(e.entityId);
        if (existing) noteTypes.set(e.entityId, { ...existing, deleted: true, updatedAt: e.timestamp });
        break;
      }
      case 'card_create': {
        const p = e.payload as Partial<Note> & { cardType?: string };
        // Legacy: 'reversed' used to be its own note type (a single card that
        // alternated direction). It's now "basic" + a reversed flag, which
        // generates a real second card instead.
        const legacyReversed = p.cardType === 'reversed';
        notes.set(e.entityId, {
          id: e.entityId,
          deckId: p.deckId as string,
          noteType: legacyReversed ? 'basic' : (p.cardType ?? 'basic'),
          front: p.front ?? '',
          back: p.back ?? '',
          fields: p.fields ?? {},
          tags: p.tags ?? [],
          reversed: legacyReversed || (p.reversed ?? false),
          deleted: false,
          createdAt: e.timestamp,
          updatedAt: e.timestamp,
        });
        break;
      }
      case 'card_edit': {
        const existing = notes.get(e.entityId);
        if (!existing) break;
        const p = e.payload as Partial<Note>;
        notes.set(e.entityId, {
          ...existing,
          front: p.front ?? existing.front,
          back: p.back ?? existing.back,
          fields: p.fields ? { ...existing.fields, ...p.fields } : existing.fields,
          tags: p.tags ?? existing.tags,
          reversed: p.reversed ?? existing.reversed,
          updatedAt: e.timestamp,
        });
        break;
      }
      case 'card_delete': {
        const existing = notes.get(e.entityId);
        if (existing) {
          notes.set(e.entityId, { ...existing, deleted: true, updatedAt: e.timestamp });
        }
        break;
      }
    }
  }

  const cards = new Map<string, Card>();
  for (const note of notes.values()) {
    // noteTypeDef stays in the map (soft-deleted) rather than disappearing —
    // explicitly re-check .deleted here, not just presence, to keep the
    // original behavior: a deleted type's notes stop generating cards.
    const noteTypeDef = noteTypes.get(note.noteType);

    if (noteTypeDef && !noteTypeDef.deleted) {
      // Joined with <br>, not '\n' — this gets rendered as raw HTML (RichText's
      // dangerouslySetInnerHTML), and HTML collapses literal newlines into a
      // single space, which stacked multiple fields horizontally instead of
      // vertically.
      const front = cleanupBrs(noteTypeDef.questionFields.map((f) => note.fields[f] ?? '').join('<br>'));
      const back = cleanupBrs(noteTypeDef.answerFields.map((f) => note.fields[f] ?? '').join('<br>'));
      // Same pattern as basic notes: front/back stay as the type's own
      // question/answer rendering for both cards — questionText/answerText
      // do the actual display-time swap based on isReversed.
      // `noteTypeDef.reversed` only makes the option available; `note.reversed`
      // is the per-note opt-in chosen when the note was created.
      const variants = noteTypeDef.reversed && note.reversed ? [false, true] : [false];
      for (const isReversed of variants) {
        const id = isReversed ? `${note.id}::reversed` : note.id;
        cards.set(id, {
          id,
          noteId: note.id,
          noteTypeId: noteTypeDef.id,
          clozeIndex: null,
          isReversed,
          deckId: note.deckId,
          cardType: 'custom',
          front,
          back,
          fields: note.fields,
          tags: note.tags,
          fsrs: newFsrsState(),
          flagged: false,
          suspended: false,
          isLeech: false,
          deleted: note.deleted,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        });
      }
      continue;
    }

    // Not a known custom type and not a built-in — this note's type was
    // deleted (or never existed). Skip it: no template exists to render it.
    if (note.noteType !== 'basic' && note.noteType !== 'cloze') {
      continue;
    }

    if (note.noteType === 'cloze') {
      for (const clozeIndex of clozeNumbers(note.front)) {
        const id = `${note.id}::${clozeIndex}`;
        cards.set(id, {
          id,
          noteId: note.id,
          noteTypeId: null,
          clozeIndex,
          isReversed: false,
          deckId: note.deckId,
          cardType: 'cloze',
          front: note.front,
          back: note.back,
          fields: {},
          tags: note.tags,
          fsrs: newFsrsState(),
          flagged: false,
          suspended: false,
          isLeech: false,
          deleted: note.deleted,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        });
      }
      continue;
    }

    // Basic note: one forward card, plus a back->front sibling if `reversed`
    // is set — two independently-scheduled cards, not one alternating card.
    const variants = note.reversed ? [false, true] : [false];
    for (const isReversed of variants) {
      const id = isReversed ? `${note.id}::reversed` : note.id;
      cards.set(id, {
        id,
        noteId: note.id,
        noteTypeId: null,
        clozeIndex: null,
        isReversed,
        deckId: note.deckId,
        cardType: 'basic',
        front: note.front,
        back: note.back,
        fields: {},
        tags: note.tags,
        fsrs: newFsrsState(),
        flagged: false,
        suspended: false,
        isLeech: false,
        deleted: note.deleted,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      });
    }
  }

  for (const e of events) {
    switch (e.type) {
      case 'card_edit': {
        const existing = cards.get(e.entityId);
        if (!existing) break;
        const p = e.payload as Partial<Pick<Card, 'flagged' | 'suspended' | 'isLeech'>>;
        cards.set(e.entityId, {
          ...existing,
          flagged: p.flagged ?? existing.flagged,
          suspended: p.suspended ?? existing.suspended,
          isLeech: p.isLeech ?? existing.isLeech,
          updatedAt: e.timestamp,
        });
        break;
      }
      case 'card_review': {
        if (undoneReviewIds.has(e.id)) break;
        const existing = cards.get(e.entityId);
        if (!existing) break;
        const rating = e.payload.rating as Grade;
        const reviewedAt = new Date(e.timestamp);
        const nextFsrs = schedule(existing.fsrs, rating, reviewedAt);
        cards.set(e.entityId, { ...existing, fsrs: nextFsrs, updatedAt: e.timestamp });
        break;
      }
    }
  }

  await db.transaction('rw', db.decks, db.cards, db.noteTypes, async () => {
    await db.decks.clear();
    await db.cards.clear();
    await db.noteTypes.clear();
    await db.decks.bulkAdd(Array.from(decks.values()));
    await db.cards.bulkAdd(Array.from(cards.values()));
    await db.noteTypes.bulkAdd(Array.from(noteTypes.values()));
  });
}

/** Convenience: push then pull, call this on app open and periodically. */
export async function sync(userId: string) {
  await pushEvents();
  return pullAndReplay(userId);
}
