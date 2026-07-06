import type { Card } from './db';
import { clozeQuestion } from './cloze';
import { extractSearchableText } from './sanitize';

/** Searchable text for one card — shared by both browse pages so their
 * matching logic can't silently drift apart. Cloze cards have no media
 * fields, so their question form (all blanks hidden) is enough; basic/custom
 * cards use extractSearchableText so an image/audio-only field's label
 * still matches, not just plain text content. */
export function cardSearchText(card: Card): string {
  if (card.cardType === 'cloze') return clozeQuestion(card.front);
  return `${extractSearchableText(card.front)} ${extractSearchableText(card.back)}`;
}
