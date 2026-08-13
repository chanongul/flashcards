import { clozeSegments } from '@/lib/cloze';
import { arrowify } from '@/lib/arrowify';

export const CLOZE_COLORS = [
  "bg-sky-900/60 text-sky-300",
  "bg-green-900/60 text-green-300",
  "bg-amber-900/60 text-amber-300",
  "bg-purple-900/60 text-purple-300",
  "bg-pink-900/60 text-pink-300",
  "bg-teal-900/60 text-teal-300",
  "bg-orange-900/60 text-orange-300",
  "bg-indigo-900/60 text-indigo-300",
];

// The "Show answer" pair for a cloze card: the upper part freezes what the
// user typed into each blank (dash if they left one empty), the lower part
// shows the correct answer. Same sentence, same non-active-number context
// text, rendered twice.
export function ClozeRevealPart({
  text,
  activeIndex,
  mode,
  userValues,
}: {
  text: string;
  activeIndex: number;
  mode: "user" | "answer";
  userValues: string[];
}) {
  let blankCount = 0;
  return (
    <p className="text-lg">
      {clozeSegments(text).map((seg, i) => {
        if (seg.type === "text")
          return <span key={i}>{arrowify(seg.value)}</span>;
        if (seg.number !== activeIndex)
          return <span key={i}>{arrowify(seg.answer)}</span>;
        const index = blankCount;
        blankCount += 1;
        const value =
          mode === "user" ? userValues[index]?.trim() || String.fromCharCode(65 + index) : seg.answer;
        const color = CLOZE_COLORS[index % CLOZE_COLORS.length];
        return (
          <span key={i} className={`rounded px-1.5 ${color}`}>
            {arrowify(value)}
          </span>
        );
      })}
    </p>
  );
}
