import { db, type Deck } from './db';

// Subdecks use Anki's own convention: no separate parentId field, just a
// "Parent::Child" delimited name. Hierarchy is entirely derived from that
// string, so it needs zero support in replayAllEvents() — decks already
// just have a name.

export function deckDisplayName(fullName: string): string {
  const parts = fullName.split('::');
  return parts[parts.length - 1];
}

/** Human-friendly rendering of the full path, e.g. "Japanese > Verbs". */
export function deckBreadcrumb(fullName: string): string {
  return fullName.split('::').join(' > ');
}

/** Same as deckBreadcrumb, but collapses the middle of a deep path into a
 * "...(N)..." placeholder (N = the number of hidden levels) once there's
 * actually something to hide — more than 2 segments — keeping only the
 * top-level ancestor and the deck's own name visible, e.g. 5 levels becomes
 * "Grandparent > ...(3)... > Subdeck". Used for CardRow's deckName label,
 * where a deeply-nested path would otherwise overflow/dominate the row. */
export function deckBreadcrumbCompact(fullName: string): string {
  const parts = fullName.split('::');
  if (parts.length <= 2) return parts.join(' > ');
  const hidden = parts.length - 2;
  return `${parts[0]} > ..(${hidden}).. > ${parts[parts.length - 1]}`;
}

export function deckParentName(fullName: string): string | null {
  const idx = fullName.lastIndexOf('::');
  return idx === -1 ? null : fullName.slice(0, idx);
}

// Hard cap on how many "::"-delimited levels a deck path can have (a
// top-level deck is level 1) — past this the indented list UI gets cramped
// and nesting stops being a useful way to organize decks.
export const MAX_DECK_DEPTH = 5;

/** How many levels deep a deck path is — a top-level deck is 1. */
export function deckDepth(fullName: string): number {
  return fullName.split('::').length;
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

// One toggle button cycles through these four in order — name/updated pick
// what to sort by, asc/desc picks the direction within that. Persisted to
// localStorage by the caller (see app/page.tsx's DECK_SORT_KEY) the same
// way deck fold state already is.
export type DeckSortMode = 'name-asc' | 'name-desc' | 'updated-desc' | 'updated-asc';

const DECK_SORT_CYCLE: DeckSortMode[] = ['name-asc', 'name-desc', 'updated-desc', 'updated-asc'];

export function nextDeckSortMode(mode: DeckSortMode): DeckSortMode {
  return DECK_SORT_CYCLE[(DECK_SORT_CYCLE.indexOf(mode) + 1) % DECK_SORT_CYCLE.length];
}

export const DECK_SORT_LABELS: Record<DeckSortMode, string> = {
  'name-asc': 'Sort: Name (A–Z)',
  'name-desc': 'Sort: Name (Z–A)',
  'updated-desc': 'Sort: Recently updated',
  'updated-asc': 'Sort: Least recently updated',
};

// A deck's own updatedAt only reflects edits to that deck's own settings/
// name — a subdeck getting reviewed or renamed doesn't touch its parent's
// row at all. For the "updated" sort modes, each deck instead sorts by the
// most recent updatedAt anywhere in its own subtree (itself included),
// same rollup idea deckCounts already uses for due/new/learning counts —
// otherwise an actively-used deck could sit buried under untouched ones
// just because only its subdecks, not the deck itself, changed recently.
function effectiveUpdatedAtById(decks: Deck[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const deck of decks) {
    let max = deck.updatedAt;
    for (const other of decks) {
      if (other.id !== deck.id && other.name.startsWith(`${deck.name}::`) && other.updatedAt > max) {
        max = other.updatedAt;
      }
    }
    map.set(deck.id, max);
  }
  return map;
}

function deckComparator(
  mode: DeckSortMode,
  effectiveUpdatedAt: Map<string, number>
): (a: Deck, b: Deck) => number {
  const dir = mode.endsWith('asc') ? 1 : -1;
  if (mode.startsWith('name')) {
    return (a, b) => deckDisplayName(a.name).localeCompare(deckDisplayName(b.name)) * dir;
  }
  return (a, b) =>
    ((effectiveUpdatedAt.get(a.id) ?? a.updatedAt) - (effectiveUpdatedAt.get(b.id) ?? b.updatedAt)) * dir;
}

/** Flattens decks into tree order (parents before children, siblings ordered
 * per `sortMode`) with depth for indentation. Sorting only ever reorders
 * siblings within a parent — hierarchy itself is untouched. */
export function flattenDeckTree(decks: Deck[], sortMode: DeckSortMode = 'name-asc'): DeckTreeRow[] {
  const byParent = new Map<string | null, Deck[]>();
  for (const deck of decks) {
    const parent = deckParentName(deck.name);
    const list = byParent.get(parent) ?? [];
    list.push(deck);
    byParent.set(parent, list);
  }
  const effectiveUpdatedAt = sortMode.startsWith('updated') ? effectiveUpdatedAtById(decks) : new Map<string, number>();
  const compare = deckComparator(sortMode, effectiveUpdatedAt);
  for (const list of byParent.values()) {
    list.sort(compare);
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
