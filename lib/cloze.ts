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

// Friendlier cloze authoring: the "Blanks" UI lets a user mark a blank with a
// single letter (A, B, C…) instead of typing {{c1::answer}} by hand. A
// {{A}} placeholder in the draft text stands in for a blank until its answer
// is filled in and the letter is resolved to its cloze number (A -> c1, B ->
// c2, …) at submit time.
const BLANK_PLACEHOLDER_PATTERN = /\{\{([A-Z])\}\}/g;

/** Distinct blank letters in a draft cloze text, in order of first appearance. */
export function clozeBlankLetters(text: string): string[] {
  const seen = new Set<string>();
  const letters: string[] = [];
  const re = new RegExp(BLANK_PLACEHOLDER_PATTERN);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      letters.push(m[1]);
    }
  }
  return letters;
}

/** Resolves {{A}}-style blank placeholders into {{c1::answer}} cloze syntax.
 * separateCards=false (the default) puts every blank under the same number
 * (c1), so they all stay on one generated card and get tested together.
 * separateCards=true gives each letter its own number (A->c1, B->c2, …),
 * matching Anki's default of one generated card per blank. */
export function buildClozeText(
  template: string,
  answers: Record<string, string>,
  separateCards: boolean
): string {
  return template.replace(BLANK_PLACEHOLDER_PATTERN, (_match, letter: string) => {
    const index = separateCards ? letter.charCodeAt(0) - 'A'.charCodeAt(0) + 1 : 1;
    return `{{c${index}::${answers[letter] ?? ''}}}`;
  });
}

/** The inverse of buildClozeText — pulls an existing {{c1::answer}}-syntax
 * note apart into the {{A}}-placeholder draft template plus a letter->answer
 * map, so an already-created cloze note can be re-opened in the same Blanks
 * editor used to create one instead of exposing the raw {{cN::...}} syntax
 * directly as editable text. Letters are assigned by occurrence order, not
 * derived from the cloze number — a combined-card note has every occurrence
 * sharing the same number, and deriving the letter from the number would
 * collapse them onto one letter, silently dropping every answer but the
 * last. separateCards reports whether the note actually used more than one
 * distinct number, so the editor can pre-check the right checkbox state. */
export function parseClozeToDraft(
  text: string
): { template: string; answers: Record<string, string>; separateCards: boolean } {
  const answers: Record<string, string> = {};
  const numbersSeen = new Set<number>();
  let occurrence = 0;
  const template = text.replace(CLOZE_PATTERN, (_match, numStr: string, answer: string) => {
    numbersSeen.add(Number(numStr));
    const letter = String.fromCharCode('A'.charCodeAt(0) + occurrence);
    occurrence += 1;
    answers[letter] = answer;
    return `{{${letter}}}`;
  });
  return { template, answers, separateCards: numbersSeen.size > 1 };
}

/** One piece of cloze text: either plain surrounding text, or one deletion
 * with its cloze number and answer. Lets a renderer treat each deletion
 * individually — e.g. showing an input for the active number's blank while
 * every other number's answer stays revealed as inline context — rather
 * than only offering the all-hidden or all-revealed strings above. */
export type ClozeSegment =
  | { type: 'text'; value: string }
  | { type: 'blank'; number: number; answer: string };

export function clozeSegments(text: string): ClozeSegment[] {
  const segments: ClozeSegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(CLOZE_PATTERN);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, m.index) });
    segments.push({ type: 'blank', number: Number(m[1]), answer: m[2] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}
