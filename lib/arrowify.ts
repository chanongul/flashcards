// Cosmetic replacement of ASCII arrow shorthand with real arrow glyphs, for
// review/preview display only — never applied to what's actually stored, so
// editing a card still shows (and round-trips) the plain "->" the user
// typed. Longer patterns are listed, and therefore matched, before the
// shorter ones they contain ("-->" before "->", "==>" before "=>") so e.g.
// "-->" becomes "⟶" whole rather than leaving a stray "-" behind from a
// "->" match eating just its last two characters.
const ARROW_REPLACEMENTS: [RegExp, string][] = [
  [/==>/g, '⟹'],
  [/<==/g, '⟸'],
  [/=>/g, '⇒'],
  [/<=/g, '⇐'],
  [/->/g, '→'],
  [/<-/g, '←'],
];

export function arrowify(text: string): string {
  let result = text;
  for (const [pattern, replacement] of ARROW_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
