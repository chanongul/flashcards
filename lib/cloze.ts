// Cloze deletion syntax: {{c1::answer}}. Each distinct cN number becomes its
// own generated card (see replayAllEvents in lib/sync.ts) — reviewing one
// hides only that number's deletions in the question while showing other
// numbers' answers inline as context, matching Anki's cloze behavior.
const CLOZE_PATTERN = /\{\{c(\d+)::(.*?)\}\}/g;

/** All deletions hidden — used for previews where there's no specific active card. */
export function clozeQuestion(text: string): string {
  return text.replace(CLOZE_PATTERN, '[...]');
}

/** All deletions revealed — used for previews and answers. */
export function clozeAnswer(text: string): string {
  return text.replace(CLOZE_PATTERN, '$2');
}

export function hasClozeDeletion(text: string): boolean {
  return new RegExp(CLOZE_PATTERN).test(text);
}

/** Distinct cloze numbers present in the text, e.g. [1, 2] for a note using c1 and c2. */
export function clozeNumbers(text: string): number[] {
  const nums = new Set<number>();
  const re = new RegExp(CLOZE_PATTERN);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) nums.add(Number(m[1]));
  return Array.from(nums).sort((a, b) => a - b);
}

/** Question for one specific cloze card: only its own number is hidden. */
export function clozeQuestionFor(text: string, activeIndex: number): string {
  return text.replace(CLOZE_PATTERN, (_match, numStr, answer) =>
    Number(numStr) === activeIndex ? '[...]' : answer
  );
}

/** Answer for one specific cloze card: everything revealed (same as clozeAnswer). */
export function clozeAnswerFor(text: string, _activeIndex: number): string {
  return clozeAnswer(text);
}
