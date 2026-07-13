import { db, type Card, type FieldTypeConfig, type TextFormat } from './db';
import { logEvent, replayAllEvents, pushEvents } from './sync';
import { MAX_DECK_DEPTH, deckDepth, deckParentName, getDeckAndDescendantIds } from './decks';

// ---- Shared shape ----
// Decks/note types/notes are represented by NAME (plus an id for round-trip
// matching within the same account) — a human or AI editing this file should
// never need to see or preserve opaque field/entity ids. Cards are exported
// grouped by note (one entry per underlying note, not per derived Card), the
// same grouping cloneDeck/cloneCard already do, since a reversed pair or a
// multi-cloze note would otherwise export as duplicate/fragmented entries.

export interface ImportPayload {
  exportedAt?: string;
  decks: { id?: string; name: string; newCardsPerDay?: number; reviewsPerDay?: number }[];
  noteTypes: {
    id?: string;
    name: string;
    fields: { name: string; type: FieldTypeConfig }[];
    questionFields: string[];
    answerFields: string[];
    fieldChoices?: Record<string, string[]>;
    fieldTemplates?: Record<string, TextFormat>;
    reversed?: boolean;
  }[];
  notes: {
    id?: string;
    deckId?: string;
    deckName: string;
    noteType: string; // 'basic' | 'cloze' | a noteTypes[].name
    front?: string;
    back?: string;
    fields?: Record<string, string>;
    tags?: string[];
    reversed?: boolean;
  }[];
}

export interface ImportSummary {
  decksCreated: number;
  noteTypesCreated: number;
  notesCreated: number;
  notesEdited: number;
  skipped: string[];
}

function emptySummary(): ImportSummary {
  return { decksCreated: 0, noteTypesCreated: 0, notesCreated: 0, notesEdited: 0, skipped: [] };
}

// ---- Export ----

export async function exportToJson(scope: { deckId: string } | 'all'): Promise<string> {
  const deckIds =
    scope === 'all'
      ? (await db.decks.filter((d) => !d.deleted).toArray()).map((d) => d.id)
      : await getDeckAndDescendantIds(scope.deckId);

  const decks = await db.decks.filter((d) => !d.deleted && deckIds.includes(d.id)).toArray();
  const deckById = new Map(decks.map((d) => [d.id, d]));

  const cardsInScope = await db.cards
    .where('deckId')
    .anyOf(deckIds)
    .filter((c) => !c.deleted)
    .toArray();

  const byNote = new Map<string, Card[]>();
  for (const card of cardsInScope) {
    const group = byNote.get(card.noteId) ?? [];
    group.push(card);
    byNote.set(card.noteId, group);
  }

  const usedNoteTypeIds = new Set<string>();
  type NoteOut = ImportPayload['notes'][number] & { _noteTypeId?: string };
  const notesOut: NoteOut[] = [];

  for (const group of byNote.values()) {
    const rep = group.find((c) => !c.isReversed) ?? group[0];
    const reversed = group.some((c) => c.isReversed);
    const deck = deckById.get(rep.deckId);
    if (!deck) continue;

    const isCustom = rep.cardType === 'custom' && !!rep.noteTypeId;
    if (isCustom) usedNoteTypeIds.add(rep.noteTypeId!);

    notesOut.push({
      id: rep.noteId,
      deckId: deck.id,
      deckName: deck.name,
      noteType: isCustom ? rep.noteTypeId! : rep.cardType, // translated to a name below, for custom types
      _noteTypeId: isCustom ? rep.noteTypeId! : undefined,
      front: isCustom ? undefined : rep.front,
      back: isCustom ? undefined : rep.back,
      fields: isCustom ? rep.fields : undefined,
      tags: rep.tags,
      reversed,
    });
  }

  const noteTypesList = await db.noteTypes
    .filter((nt) => !nt.deleted && usedNoteTypeIds.has(nt.id))
    .toArray();
  const noteTypeById = new Map(noteTypesList.map((nt) => [nt.id, nt]));

  for (const n of notesOut) {
    if (!n._noteTypeId) continue;
    const nt = noteTypeById.get(n._noteTypeId);
    if (!nt) continue;
    const translated: Record<string, string> = {};
    for (const [fieldId, value] of Object.entries(n.fields ?? {})) {
      translated[nt.fieldNames[fieldId] ?? fieldId] = value;
    }
    n.fields = translated;
    n.noteType = nt.name;
    delete n._noteTypeId;
  }

  const noteTypesOut: ImportPayload['noteTypes'] = noteTypesList.map((nt) => {
    const choices: Record<string, string[]> = {};
    for (const [fieldId, values] of Object.entries(nt.fieldChoices)) {
      choices[nt.fieldNames[fieldId] ?? fieldId] = values;
    }
    const templates: Record<string, TextFormat> = {};
    for (const [fieldId, format] of Object.entries(nt.fieldTemplates)) {
      templates[nt.fieldNames[fieldId] ?? fieldId] = format;
    }
    return {
      id: nt.id,
      name: nt.name,
      fields: nt.fields.map((fieldId) => ({
        name: nt.fieldNames[fieldId] ?? fieldId,
        type: nt.fieldTypes[fieldId] ?? 'richtext',
      })),
      questionFields: nt.questionFields.map((fieldId) => nt.fieldNames[fieldId] ?? fieldId),
      answerFields: nt.answerFields.map((fieldId) => nt.fieldNames[fieldId] ?? fieldId),
      fieldChoices: choices,
      fieldTemplates: templates,
      reversed: nt.reversed,
    };
  });

  const payload: ImportPayload = {
    exportedAt: new Date().toISOString(),
    decks: decks.map((d) => ({
      id: d.id,
      name: d.name,
      newCardsPerDay: d.newCardsPerDay,
      reviewsPerDay: d.reviewsPerDay,
    })),
    noteTypes: noteTypesOut,
    notes: notesOut.map(({ _noteTypeId, ...rest }) => rest),
  };
  return JSON.stringify(payload, null, 2);
}

// ---- Import: JSON ----

export function parseImportJson(text: string): { data: ImportPayload } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'Not valid JSON.' };
  }
  if (typeof raw !== 'object' || raw === null) return { error: 'Malformed import file.' };

  const obj = raw as Record<string, unknown>;
  const decks = Array.isArray(obj.decks) ? (obj.decks as ImportPayload['decks']) : [];
  const noteTypes = Array.isArray(obj.noteTypes) ? (obj.noteTypes as ImportPayload['noteTypes']) : [];
  const notes = Array.isArray(obj.notes) ? (obj.notes as ImportPayload['notes']) : [];

  if (notes.length === 0) return { error: 'File has no notes to import.' };

  const seenIds = new Set<string>();
  for (const n of notes) {
    if (n.id) {
      if (seenIds.has(n.id)) return { error: `Duplicate note id "${n.id}" in file.` };
      seenIds.add(n.id);
    }
    if (!n.deckName) return { error: 'Every note must have a "deckName".' };
    if (!n.noteType) return { error: 'Every note must have a "noteType".' };
  }

  return { data: { decks, noteTypes, notes } };
}

export async function applyImportJson(userId: string, data: ImportPayload): Promise<ImportSummary> {
  const summary = emptySummary();

  const localDecks = await db.decks.filter((d) => !d.deleted).toArray();
  const localDecksById = new Map(localDecks.map((d) => [d.id, d]));
  const deckNameToId = new Map(localDecks.map((d) => [d.name, d.id]));

  // Recursively resolves (or creates, ancestor-first) a "Parent::Child" deck
  // path against `deckNameToId`, memoizing as it goes — mirrors createDeck's
  // own ancestor-splitting logic (lib/actions.ts), but resolved once per
  // distinct name up front rather than re-querying Dexie mid-loop, since
  // nothing is replayed until this whole import finishes.
  async function ensureDeckChain(fullName: string): Promise<string | null> {
    const cached = deckNameToId.get(fullName);
    if (cached) return cached;
    if (deckDepth(fullName) > MAX_DECK_DEPTH) {
      summary.skipped.push(`Deck "${fullName}" exceeds max nesting depth (${MAX_DECK_DEPTH}) — skipped.`);
      return null;
    }
    const parent = deckParentName(fullName);
    if (parent) {
      const parentId = await ensureDeckChain(parent);
      if (parentId === null) {
        summary.skipped.push(`Deck "${fullName}" skipped — parent could not be created.`);
        return null;
      }
    }
    const id = crypto.randomUUID();
    await logEvent(userId, id, 'deck_create', { name: fullName });
    deckNameToId.set(fullName, id);
    summary.decksCreated++;
    return id;
  }

  // Keyed by the payload deck's own id (preferred, survives a local rename)
  // or its name (fallback — cross-account share, or no id in the file).
  const deckKeyToLocalId = new Map<string, string>();
  for (const d of data.decks) {
    const localId = (d.id && localDecksById.get(d.id)?.id) ?? (await ensureDeckChain(d.name));
    if (localId) deckKeyToLocalId.set(d.id ?? d.name, localId);
  }

  const localNoteTypes = await db.noteTypes.filter((nt) => !nt.deleted).toArray();
  const localNoteTypesById = new Map(localNoteTypes.map((nt) => [nt.id, nt]));
  const localNoteTypesByName = new Map(localNoteTypes.map((nt) => [nt.name, nt]));

  // Keyed by the payload note type's NAME, since that's how notes[] refers
  // to it — resolves to whichever local note type ends up owning that name
  // (matched by id, matched by name, or freshly created) plus a field
  // display-name -> local field-id map for translating note.fields.
  const noteTypeByPayloadName = new Map<string, { id: string; fieldNameToId: Map<string, string> }>();

  for (const nt of data.noteTypes) {
    const existing = (nt.id && localNoteTypesById.get(nt.id)) ?? localNoteTypesByName.get(nt.name);

    if (existing) {
      const fieldNameToId = new Map(Object.entries(existing.fieldNames).map(([id, name]) => [name, id]));
      noteTypeByPayloadName.set(nt.name, { id: existing.id, fieldNameToId });
      continue;
    }

    const fieldIds = nt.fields.map(() => crypto.randomUUID());
    const fieldNameToId = new Map(nt.fields.map((f, i) => [f.name, fieldIds[i]]));
    const fieldNames: Record<string, string> = {};
    const fieldTypes: Record<string, FieldTypeConfig> = {};
    nt.fields.forEach((f, i) => {
      fieldNames[fieldIds[i]] = f.name;
      fieldTypes[fieldIds[i]] = f.type;
    });
    const translateNames = (names: string[]) =>
      names.map((name) => fieldNameToId.get(name)).filter((id): id is string => !!id);
    const fieldChoices: Record<string, string[]> = {};
    for (const [name, choices] of Object.entries(nt.fieldChoices ?? {})) {
      const id = fieldNameToId.get(name);
      if (id) fieldChoices[id] = choices;
    }
    const fieldTemplates: Record<string, TextFormat> = {};
    for (const [name, format] of Object.entries(nt.fieldTemplates ?? {})) {
      const id = fieldNameToId.get(name);
      if (id) fieldTemplates[id] = format;
    }

    const newId = crypto.randomUUID();
    await logEvent(userId, newId, 'notetype_create', {
      name: nt.name,
      fields: fieldIds,
      fieldNames,
      questionFields: translateNames(nt.questionFields ?? []),
      answerFields: translateNames(nt.answerFields ?? []),
      fieldTypes,
      reversed: nt.reversed ?? false,
      fieldChoices,
      fieldTemplates,
    });
    summary.noteTypesCreated++;
    noteTypeByPayloadName.set(nt.name, { id: newId, fieldNameToId });
  }

  // Representative (non-reversed-first) card per existing local note, for
  // id-matching and to know a note type's full current field-id list.
  const localCards = await db.cards.filter((c) => !c.deleted).toArray();
  const localNotesById = new Map<string, Card>();
  {
    const byNote = new Map<string, Card[]>();
    for (const c of localCards) {
      const group = byNote.get(c.noteId) ?? [];
      group.push(c);
      byNote.set(c.noteId, group);
    }
    for (const [noteId, group] of byNote) {
      localNotesById.set(noteId, group.find((c) => !c.isReversed) ?? group[0]);
    }
  }

  for (const n of data.notes) {
    const localDeckId =
      (n.deckId && deckKeyToLocalId.get(n.deckId)) ??
      deckKeyToLocalId.get(n.deckName) ??
      (await ensureDeckChain(n.deckName));
    if (!localDeckId) {
      summary.skipped.push(`Note in deck "${n.deckName}" skipped — deck could not be resolved.`);
      continue;
    }

    let cardType: string;
    let fields: Record<string, string> | undefined;
    const front = n.front ?? '';
    const back = n.back ?? '';

    if (n.noteType === 'basic' || n.noteType === 'cloze') {
      cardType = n.noteType;
      fields = undefined;
    } else {
      const resolved = noteTypeByPayloadName.get(n.noteType);
      if (!resolved) {
        summary.skipped.push(`Note references unknown note type "${n.noteType}" — skipped.`);
        continue;
      }
      cardType = resolved.id;
      // Built from the note type's FULL field list, not just the keys
      // present in the file: card_edit's fold does a shallow merge onto the
      // existing note's fields, so an omitted key would otherwise silently
      // keep its old value instead of being cleared.
      fields = {};
      for (const [name, id] of resolved.fieldNameToId) {
        fields[id] = n.fields?.[name] ?? '';
      }
    }

    const existing = n.id ? localNotesById.get(n.id) : undefined;
    if (existing) {
      await logEvent(userId, n.id!, 'card_edit', {
        front,
        back,
        fields,
        tags: n.tags ?? [],
        reversed: n.reversed ?? false,
      });
      summary.notesEdited++;
    } else {
      await logEvent(userId, crypto.randomUUID(), 'card_create', {
        deckId: localDeckId,
        cardType,
        front,
        back,
        tags: n.tags ?? [],
        fields,
        reversed: n.reversed ?? false,
      });
      summary.notesCreated++;
    }
  }

  await replayAllEvents();
  void pushEvents();
  return summary;
}

// ---- Import: CSV (quick bulk-add, basic cards only) ----

export interface CsvRow {
  front: string;
  back: string;
  tags: string[];
}

// Minimal RFC4180-subset tokenizer: quoted fields (with "" escaping and
// embedded commas/newlines), unquoted fields split on commas. Not meant to
// be a general-purpose parser — malformed input just tokenizes oddly rather
// than throwing, callers validate the result instead of trusting the parse.
function tokenizeCsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  records.push(row);
  return records;
}

export function parseCsv(text: string): { rows: CsvRow[]; errors: string[] } {
  const errors: string[] = [];
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = tokenizeCsv(normalized).filter((r) => !(r.length === 1 && r[0] === ''));

  if (records.length === 0) return { rows: [], errors: ['File is empty.'] };

  const header = records[0].map((h) => h.trim().toLowerCase());
  const frontIdx = header.indexOf('front');
  const backIdx = header.indexOf('back');
  const tagsIdx = header.indexOf('tags');
  if (frontIdx === -1 || backIdx === -1) {
    return { rows: [], errors: ['Header row must include "Front" and "Back" columns.'] };
  }

  const rows: CsvRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    const front = (rec[frontIdx] ?? '').trim();
    const back = (rec[backIdx] ?? '').trim();
    if (!front && !back) continue;
    if (!front || !back) {
      errors.push(`Row ${i + 1}: missing Front or Back.`);
      continue;
    }
    const tagsCell = tagsIdx !== -1 ? (rec[tagsIdx] ?? '') : '';
    const tags = tagsCell.split(';').map((t) => t.trim()).filter(Boolean);
    rows.push({ front, back, tags });
  }
  return { rows, errors };
}

export async function applyCsvImport(userId: string, deckId: string, rows: CsvRow[]): Promise<ImportSummary> {
  const summary = emptySummary();
  for (const row of rows) {
    await logEvent(userId, crypto.randomUUID(), 'card_create', {
      deckId,
      cardType: 'basic',
      front: row.front,
      back: row.back,
      tags: row.tags,
      reversed: false,
    });
    summary.notesCreated++;
  }
  await replayAllEvents();
  void pushEvents();
  return summary;
}
