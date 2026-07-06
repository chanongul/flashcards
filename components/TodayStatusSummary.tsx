'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { countCardsByState, DECK_COUNT_TOOLTIPS } from '@/lib/stats';

// Same 3-way status split (and colors) already used per-deck in the deck
// list below — this is just the total across the whole collection. Bars
// are sized relative to the largest of the three counts (not to a fixed
// scale), since the point is comparing New/Learning/Due to each other at a
// glance, not tracking a count against some absolute target.
const ROWS = [
  { key: 'newCount', label: 'New', bar: 'bg-sky-400', text: 'text-sky-400', tooltip: DECK_COUNT_TOOLTIPS.new },
  {
    key: 'learningCount',
    label: 'Learning',
    bar: 'bg-orange-600',
    text: 'text-orange-600',
    tooltip: DECK_COUNT_TOOLTIPS.learning,
  },
  { key: 'dueCount', label: 'Due', bar: 'bg-olive-300', text: 'text-olive-300', tooltip: DECK_COUNT_TOOLTIPS.due },
] as const;

export function TodayStatusSummary() {
  const counts = useLiveQuery(async () => {
    const cards = await db.cards.filter((c) => !c.deleted && !c.suspended).toArray();
    return countCardsByState(cards);
  }, []);

  if (!counts) return null;

  const max = Math.max(counts.newCount, counts.learningCount, counts.dueCount, 1);

  return (
    <div className="space-y-1.5" title="Today, across every deck">
      {ROWS.map((row) => {
        const value = counts[row.key];
        return (
          <div key={row.key} className="flex items-center gap-2" title={row.tooltip}>
            <span className={`w-16 shrink-0 text-xs ${row.text}`}>{row.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-900">
              <div
                className={`h-full rounded-full ${row.bar} transition-[width]`}
                style={{ width: `${(value / max) * 100}%` }}
              />
            </div>
            <span className="w-6 shrink-0 text-right text-xs text-neutral-400">{value}</span>
          </div>
        );
      })}
    </div>
  );
}
