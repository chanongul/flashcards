import type { Card } from './db';
import { clozeQuestion, clozeQuestionFor, clozeAnswer } from './cloze';

// Front/back as plain rendered HTML for any card type — front/back swap on
// isReversed for basic/custom cards (a cloze note can't be reversed), while
// cloze cards ignore that and instead hide/reveal by cloze number. This is
// the "just show me both sides" rendering (card preview, game mode); the
// main review flow instead uses the interactive per-blank cloze UI
// (ClozeFillIn/ClozeRevealPart in app/review/[deckId]/page.tsx) for cloze
// cards specifically, since typing into the active blank has no equivalent
// here.
export function cardFrontHtml(card: Card): string {
  if (card.cardType === 'cloze') {
    return card.clozeIndex !== null ? clozeQuestionFor(card.front, card.clozeIndex) : clozeQuestion(card.front);
  }
  return card.isReversed ? card.back : card.front;
}

export function cardBackHtml(card: Card): string {
  if (card.cardType === 'cloze') return clozeAnswer(card.front);
  return card.isReversed ? card.front : card.back;
}
