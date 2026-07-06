import Dexie, { type EntityTable } from 'dexie';

// ---- Types ----

export type CardType = 'basic' | 'cloze' | 'custom';

export const DEFAULT_NEW_CARDS_PER_DAY = 20;
export const DEFAULT_REVIEWS_PER_DAY = 200;
export const LEECH_THRESHOLD = 8;

export interface Deck {
  id: string; // uuid
  name: string;
  newCardsPerDay: number;
  reviewsPerDay: number;
  createdAt: number;
  updatedAt: number;
}

export interface FsrsState {
  due: number; // timestamp, ms
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number; // 0=New, 1=Learning, 2=Review, 3=Relearning
  last_review: number | null;
}

// A custom note type: an ordered field list plus which fields render on the
// question vs answer. One note type produces exactly one card template (not
// Anki's full multi-template-per-type system — that's out of scope for now).
export interface NoteType {
  id: string; // uuid
  name: string; // e.g. "Vocabulary"
  fields: string[]; // ordered, e.g. ["Word", "Reading", "Meaning", "Example"]
  questionFields: string[]; // subset/order of `fields` shown on the question
  answerFields: string[]; // subset/order of `fields` shown on the answer
  reversed: boolean; // whether notes of this type may opt into an answer->question sibling card
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}

// A Note holds content; it's never persisted directly (no Dexie table) — it
// only exists as an intermediate step in replayAllEvents(), which derives one
// or more Cards from it. Basic/custom notes normally produce exactly one card
// (id == noteId) — except a basic note with `reversed: true`, which also
// produces a back->front sibling card (id == `${noteId}::reversed`), matching
// Anki's "Basic (and reversed card)": two independently-scheduled cards from
// one note, not one card that alternates direction. Cloze notes produce one
// card per distinct {{cN::...}} number; custom-note-type notes produce one
// card whose front/back are rendered from `fields` using the note type's
// questionFields/answerFields.
export interface Note {
  id: string; // uuid; same id space as card_create/card_edit/card_delete events
  deckId: string;
  noteType: string; // 'basic' | 'cloze' | a NoteType.id
  front: string;
  back: string;
  fields: Record<string, string>; // used when noteType references a custom NoteType
  tags: string[];
  reversed: boolean; // opt-in per note: also generate a back->front sibling card (basic notes, or custom types with reversed enabled)
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Card {
  id: string; // uuid for basic/custom (== noteId); `${noteId}::${clozeIndex}` for cloze; `${noteId}::reversed` for a reversed sibling
  noteId: string;
  noteTypeId: string | null; // set when cardType === 'custom'
  clozeIndex: number | null; // which {{cN::...}} this card quizzes; null otherwise
  isReversed: boolean; // true only for the auto-generated back->front sibling of a reversed basic note
  deckId: string;
  cardType: CardType;
  front: string; // for custom cards, pre-rendered from fields at replay time
  back: string;
  fields: Record<string, string>; // raw field values, for editing custom cards
  tags: string[];
  fsrs: FsrsState;
  flagged: boolean;
  suspended: boolean; // excluded from due queue until unsuspended
  isLeech: boolean; // lapses crossed the leech threshold; auto-suspended when set
  deleted: boolean; // tombstone, never hard-delete locally
  createdAt: number;
  updatedAt: number;
}

// Append-only event log. This is the source of truth that gets synced.
// Local card/deck tables above are just a materialized view for fast rendering —
// they get rebuilt by replaying events, so they're safe to wipe and regenerate.
export type EventType =
  | 'deck_create'
  | 'deck_edit'
  | 'deck_delete'
  | 'card_create'
  | 'card_edit'
  | 'card_delete'
  | 'card_review'
  | 'card_review_undo'
  | 'notetype_create'
  | 'notetype_edit'
  | 'notetype_delete';

export interface ReviewEvent {
  id: string; // uuid, event id
  userId: string;
  entityId: string; // deckId, cardId, or noteTypeId this event applies to
  type: EventType;
  payload: Record<string, unknown>;
  clientId: string; // which device created this event
  timestamp: number; // ms, when the event happened (used for replay ordering)
  synced: boolean; // has this been pushed to Supabase yet
}

// ---- Database ----

class FlashcardDB extends Dexie {
  decks!: EntityTable<Deck, 'id'>;
  cards!: EntityTable<Card, 'id'>;
  events!: EntityTable<ReviewEvent, 'id'>;
  noteTypes!: EntityTable<NoteType, 'id'>;

  constructor() {
    super('FlashcardDB');
    this.version(1).stores({
      decks: 'id, name, updatedAt',
      cards: 'id, deckId, deleted, [deckId+deleted], updatedAt, fsrs.due',
      events: 'id, entityId, type, timestamp, synced',
    });
    this.version(2).stores({
      decks: 'id, name, updatedAt',
      cards: 'id, deckId, deleted, [deckId+deleted], updatedAt, fsrs.due',
      events: 'id, entityId, type, timestamp, synced',
      noteTypes: 'id, name, deleted',
    });
  }
}

export const db = new FlashcardDB();

// Request persistent storage so iOS/Chrome are less likely to evict our data.
// Safe to call repeatedly; browsers dedupe the request.
export async function requestPersistentStorage() {
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    const granted = await navigator.storage.persist();
    return granted;
  }
  return false;
}
