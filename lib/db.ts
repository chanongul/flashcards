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
  deleted: boolean;
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

// The actual widget/content a single field holds: plain formatted text,
// exactly one image, exactly one audio clip, or one value picked from a
// fixed list of options (never mixed in one field).
export type FieldType = 'richtext' | 'image' | 'audio' | 'choice';

// What gets declared per field on a custom NoteType. 'dynamic' means "let
// each note choose its own FieldType for this field" (same toggle UI and
// content-based inference as Basic's Front/Back, which have no persistent
// per-type schema to fix a type to); 'asset' is the same per-note deferred
// choice narrowed to just image/audio (no text/choice option) — for a field
// that's always some piece of media, but not always the same kind; a fixed
// FieldType means every note of this type always shows that one widget for
// this field, no toggle.
export type FieldTypeConfig = FieldType | 'dynamic' | 'asset';

// The rich text effects RichTextInput's toolbar exposes, captured as flags
// rather than HTML — used wherever an effect applies to a whole string at
// once (a choice field's picked option, a note type's per-field starter
// template) rather than to part of a live selection. size===3 means normal
// (no wrapping span); see FONT_SIZE_VALUES in lib/sanitize.ts for the
// allowed non-normal steps.
export interface TextFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  size: number;
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
  fieldTypes: Record<string, FieldTypeConfig>; // per-field type; missing entries default to 'richtext'
  // Shared option list for a field whose fieldTypes entry is 'choice' — one
  // list per field name, reused by every note of this type (not settable
  // per-note the way 'dynamic' fields are, since the options themselves live
  // here on the type, not on any one note's content).
  fieldChoices: Record<string, string[]>;
  // Starter formatting for a 'richtext' or 'choice' field, captured from
  // whatever effects were toggled on that field's name while defining the
  // type — applied (format only, never the name's own text) as the format
  // a brand-new card's blank field starts in. Not meaningful for other
  // field types.
  fieldTemplates: Record<string, TextFormat>;
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
  | 'notetype_delete'
  // A tombstone, not a fact about any one entity — replayAllEvents ignores
  // every event timestamped at or before the latest one of these, on every
  // device that ever pulls it, which is what makes "reset all data" actually
  // reach devices other than the one that triggered it (see resetAllData in
  // lib/sync.ts). entityId is unused (always the resetting user's id).
  | 'full_reset';

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

// An image/audio file inserted into a field but not yet uploaded. Upload is
// deferred to submit time (see lib/mediaSync.ts's resolvePendingMediaInHtml)
// so an abandoned "add card" edit never leaves an orphaned file in R2 —
// referenced from a field's HTML as data-media-id="pending:{id}" until
// resolved to the real /api/media/{filename} id. Lives only on the device
// that recorded/picked it — not synced like the event log.
export interface PendingMedia {
  id: string; // uuid
  kind: 'image' | 'audio';
  blob: Blob;
  createdAt: number;
  // Only set once a real, already-saved card has been found still
  // referencing this item's pending:{id} (i.e. its submit-time upload
  // attempt failed while offline/network-flaky). The background sync in
  // SyncManager only ever retries committed items — an uncommitted item's
  // media is still only referenced by an open, unsaved editor, and
  // grabbing it in the background would race with that editor's own
  // submit-time resolve: the file could get uploaded and this row deleted
  // before the card is ever saved, leaving a "pending:" marker nothing will
  // ever resolve.
  committed: boolean;
}

// ---- Database ----

class FlashcardDB extends Dexie {
  decks!: EntityTable<Deck, 'id'>;
  cards!: EntityTable<Card, 'id'>;
  events!: EntityTable<ReviewEvent, 'id'>;
  noteTypes!: EntityTable<NoteType, 'id'>;
  pendingMedia!: EntityTable<PendingMedia, 'id'>;

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
    this.version(3).stores({
      decks: 'id, name, updatedAt',
      cards: 'id, deckId, deleted, [deckId+deleted], updatedAt, fsrs.due',
      events: 'id, entityId, type, timestamp, synced',
      noteTypes: 'id, name, deleted',
      pendingMedia: 'id, createdAt',
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
