import { db, type Deck } from './db';

// Subdecks use Anki's own convention: no separate parentId field, just a
// "Parent::Child" delimited name. Hierarchy is entirely derived from that
// string, so it needs zero support in replayAllEvents() — decks already
// just have a name.

export function deckDisplayName(fullName: string): string {
  const parts = fullName.split('::');
  return parts[parts.length - 1];
}

/** Human-friendly rendering of the full path, e.g. "Japanese › Verbs". */
export function deckBreadcrumb(fullName: string): string {
  return fullName.split('::').join(' › ');
}

export function deckParentName(fullName: string): string | null {
  const idx = fullName.lastIndexOf('::');
  return idx === -1 ? null : fullName.slice(0, idx);
}

/** All ancestor full-path names, nearest-parent last. Doesn't include fullName itself. */
export function ancestorNames(fullName: string): string[] {
  const parts = fullName.split('::');
  const names: string[] = [];
  let path = '';
  for (let i = 0; i < parts.length - 1; i++) {
    path = path ? `${path}::${parts[i]}` : parts[i];
    names.push(path);
  }
  return names;
}

export interface DeckTreeRow {
  deck: Deck;
  depth: number;
}

/** Flattens decks into tree order (parents before children, alphabetical within a level) with depth for indentation. */
export function flattenDeckTree(decks: Deck[]): DeckTreeRow[] {
  const byParent = new Map<string | null, Deck[]>();
  for (const deck of decks) {
    const parent = deckParentName(deck.name);
    const list = byParent.get(parent) ?? [];
    list.push(deck);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => deckDisplayName(a.name).localeCompare(deckDisplayName(b.name)));
  }

  const rows: DeckTreeRow[] = [];
  function walk(parentName: string | null, depth: number) {
    for (const deck of byParent.get(parentName) ?? []) {
      rows.push({ deck, depth });
      walk(deck.name, depth + 1);
    }
  }
  walk(null, 0);
  return rows;
}

/** The deck itself plus every descendant deck (name starts with "thisDeck::"). */
export async function getDeckAndDescendantIds(deckId: string): Promise<string[]> {
  const deck = await db.decks.get(deckId);
  if (!deck) return [deckId];
  const descendants = await db.decks
    .where('name')
    .startsWith(`${deck.name}::`)
    .filter((d) => !d.deleted)
    .toArray();
  return [deckId, ...descendants.map((d) => d.id)];
}
