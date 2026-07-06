'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDailyReviewCounts, dateKey } from '@/lib/stats';

// Sun=0 .. Sat=6; only label every other row (GitHub's convention) to avoid
// ambiguity between e.g. Tuesday/Thursday both starting with "T".
const DAY_LABELS = ['', 'M', '', 'W', '', 'F', ''];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function colorForCount(count: number): string {
  if (count === 0) return 'bg-neutral-900';
  if (count < 4) return 'bg-green-900';
  if (count < 10) return 'bg-green-700';
  if (count < 20) return 'bg-green-500';
  return 'bg-green-300';
}

interface GridCell {
  key: string;
  col: number;
  row: number; // 0 (Sun) .. 6 (Sat)
  blank: boolean;
  count: number;
  title: string;
}

interface MonthLabel {
  col: number;
  label: string;
}

function buildGrid(counts: Map<string, number>, today: Date) {
  const startDate = new Date(today.getFullYear(), 0, 1);
  const totalDays = Math.round((today.getTime() - startDate.getTime()) / MS_PER_DAY) + 1;

  const days: { date: Date; key: string; count: number }[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const key = dateKey(d);
    days.push({ date: d, key, count: counts.get(key) ?? 0 });
  }

  // Group contiguous days by calendar month.
  const groups: { days: typeof days }[] = [];
  for (const day of days) {
    const last = groups[groups.length - 1];
    const lastDay = last?.days[last.days.length - 1];
    if (lastDay && lastDay.date.getMonth() === day.date.getMonth() && lastDay.date.getFullYear() === day.date.getFullYear()) {
      last.days.push(day);
    } else {
      groups.push({ days: [day] });
    }
  }

  const cells: GridCell[] = [];
  const monthLabels: MonthLabel[] = [];
  let colOffset = 0;

  groups.forEach((group, gi) => {
    const isLast = gi === groups.length - 1;
    const leading = group.days[0].date.getDay();

    monthLabels.push({
      col: colOffset,
      label: group.days[0].date.toLocaleDateString(undefined, { month: 'short' }),
    });

    for (let i = 0; i < leading; i++) {
      cells.push({
        key: `blank-lead-${gi}-${i}`,
        col: colOffset + Math.floor(i / 7),
        row: i % 7,
        blank: true,
        count: 0,
        title: '',
      });
    }

    group.days.forEach((day, di) => {
      const cellIndex = leading + di;
      cells.push({
        key: day.key,
        col: colOffset + Math.floor(cellIndex / 7),
        row: cellIndex % 7,
        blank: false,
        count: day.count,
        title: `${day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${day.count} review${day.count === 1 ? '' : 's'}`,
      });
    });

    const usedCells = leading + group.days.length;
    // Pad a completed month's last column out to Saturday, so the next month
    // starts fresh in its own column instead of sharing a partial week.
    const totalCells = isLast ? usedCells : Math.ceil(usedCells / 7) * 7;

    if (!isLast) {
      for (let i = usedCells; i < totalCells; i++) {
        cells.push({
          key: `blank-trail-${gi}-${i}`,
          col: colOffset + Math.floor(i / 7),
          row: i % 7,
          blank: true,
          count: 0,
          title: '',
        });
      }
    }

    colOffset += Math.ceil(totalCells / 7);
  });

  return { cells, monthLabels, totalColumns: colOffset };
}

interface TooltipState {
  key: string;
  text: string;
  cellLeft: number;
  cellTop: number;
  cellRight: number;
  cellBottom: number;
}

const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 6;

export function ReviewHeatmap() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Position after the tooltip has rendered (and we know its real size), so
  // it can be clamped to stay fully on-screen instead of running off the
  // left/right/top edge near the grid's boundaries.
  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) {
      setTooltipPos(null);
      return;
    }
    const rect = tooltipRef.current.getBoundingClientRect();
    let left = tooltip.cellLeft + (tooltip.cellRight - tooltip.cellLeft) / 2 - rect.width / 2;
    left = Math.min(Math.max(left, TOOLTIP_MARGIN), window.innerWidth - rect.width - TOOLTIP_MARGIN);

    let top = tooltip.cellTop - rect.height - TOOLTIP_GAP;
    if (top < TOOLTIP_MARGIN) {
      top = tooltip.cellBottom + TOOLTIP_GAP; // not enough room above — flip below
    }
    setTooltipPos({ left, top });
  }, [tooltip]);

  useEffect(() => {
    if (!tooltip) return;

    // Only dismiss on a tap/click OUTSIDE the heatmap — a tap on a cell
    // needs to reach that cell's own onClick (which toggles/switches the
    // tooltip), not get pre-empted by this handler first.
    const onPointerDown = (e: Event) => {
      if (containerRef.current && e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setTooltip(null);
      }
    };
    const dismiss = () => setTooltip(null);

    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('mousedown', onPointerDown);
    // capture:true so this still fires for scrolls inside the heatmap's own
    // overflow-x-auto strip, which wouldn't otherwise bubble to window.
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [tooltip]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolledRef = useRef(false);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfYear = new Date(today.getFullYear(), 0, 1);
  const daysSoFar = Math.round((today.getTime() - startOfYear.getTime()) / MS_PER_DAY) + 1;

  const counts = useLiveQuery(() => getDailyReviewCounts(daysSoFar), [daysSoFar]);

  // Once, on first real render (not on every later live-query update, which
  // would otherwise yank a manually-scrolled-left view back to today),
  // scroll to the far right so the most recent days are what's visible.
  useLayoutEffect(() => {
    if (hasAutoScrolledRef.current || !counts || !scrollRef.current) return;
    scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    hasAutoScrolledRef.current = true;
  }, [counts]);

  if (!counts) return null;

  const { cells, monthLabels, totalColumns } = buildGrid(counts, today);
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  const rowTemplate = '12px repeat(7, 10px)';

  return (
    <>
      <div ref={containerRef}>
        <p className="mb-2 text-xs text-neutral-500">
          {total} reviews in {today.getFullYear()}
        </p>
        <div className="flex gap-[3px]">
          <div className="grid gap-[3px]" style={{ gridTemplateRows: rowTemplate }}>
            <div />
            {DAY_LABELS.map((label, i) => (
              <div key={i} className="flex h-[10px] w-3 items-center text-[9px] leading-none text-neutral-500">
                {label}
              </div>
            ))}
          </div>
          <div ref={scrollRef} className="overflow-x-auto">
            <div
              className="grid gap-[3px]"
              style={{ gridTemplateColumns: `repeat(${totalColumns}, 10px)`, gridTemplateRows: rowTemplate }}
            >
              {monthLabels.map((m) => (
                <div
                  key={`month-${m.col}`}
                  style={{ gridColumn: m.col + 1, gridRow: 1 }}
                  className="whitespace-nowrap text-[9px] leading-none text-neutral-500"
                >
                  {m.label}
                </div>
              ))}
              {cells.map((cell) => (
                <div
                  key={cell.key}
                  style={{ gridColumn: cell.col + 1, gridRow: cell.row + 2 }}
                  onClick={(e) => {
                    if (cell.blank) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip((prev) =>
                      prev?.key === cell.key
                        ? null
                        : {
                            key: cell.key,
                            text: cell.title,
                            cellLeft: rect.left,
                            cellTop: rect.top,
                            cellRight: rect.right,
                            cellBottom: rect.bottom,
                          }
                    );
                  }}
                  aria-label={cell.title || undefined}
                  className={`h-[10px] w-[10px] rounded-sm ${cell.blank ? 'border border-neutral-900' : `${colorForCount(cell.count)} cursor-pointer`}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      {tooltip &&
        createPortal(
          <div
            ref={tooltipRef}
            style={{
              left: tooltipPos?.left ?? tooltip.cellLeft,
              top: tooltipPos?.top ?? tooltip.cellTop,
              visibility: tooltipPos ? 'visible' : 'hidden',
            }}
            className="pointer-events-none fixed z-[60] max-w-[calc(100vw-16px)] whitespace-nowrap rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-100 shadow-lg"
          >
            {tooltip.text}
          </div>,
          document.body
        )}
    </>
  );
}
