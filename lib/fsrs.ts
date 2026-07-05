import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
  type Card as FsrsCardInternal,
  type Grade,
} from 'ts-fsrs';
import type { FsrsState } from './db';

// Default parameters. These work reasonably well out of the box;
// ts-fsrs supports optimizing them from your own review history later
// once you have enough data (a few hundred reviews), but defaults are fine for v1.
const params = generatorParameters({ enable_fuzz: true });
const scheduler = fsrs(params);

export { Rating };
export type { Grade };

export function newFsrsState(): FsrsState {
  const empty = createEmptyCard(new Date());
  return toFsrsState(empty);
}

function toFsrsState(card: FsrsCardInternal): FsrsState {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as number,
    last_review: card.last_review ? card.last_review.getTime() : null,
  };
}

function toFsrsCard(state: FsrsState): FsrsCardInternal {
  return {
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsed_days,
    scheduled_days: state.scheduled_days,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state as State,
    last_review: state.last_review ? new Date(state.last_review) : undefined,
  };
}

/**
 * Given a card's current FSRS state and a rating (Again/Hard/Good/Easy),
 * returns the next state. Pass reviewedAt explicitly (rather than "now")
 * so this stays deterministic when replaying the event log.
 */
export function schedule(
  currentState: FsrsState,
  rating: Grade,
  reviewedAt: Date
): FsrsState {
  const card = toFsrsCard(currentState);
  const result = scheduler.next(card, reviewedAt, rating);
  return toFsrsState(result.card);
}

export function isDue(state: FsrsState, now: number = Date.now()): boolean {
  return state.due <= now;
}

const STATE_LABELS = ['New', 'Learning', 'Review', 'Relearning'] as const;
export type StateLabel = (typeof STATE_LABELS)[number];

export function stateLabel(state: number): StateLabel {
  return STATE_LABELS[state] ?? 'New';
}

const RATING_LABELS = ['Manual', 'Again', 'Hard', 'Good', 'Easy'] as const;
export type RatingLabel = (typeof RATING_LABELS)[number];

export function ratingLabel(rating: number): RatingLabel {
  return RATING_LABELS[rating] ?? 'Manual';
}
