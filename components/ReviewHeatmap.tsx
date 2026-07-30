'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getDailyReviewCounts, getYearsWithReviews, dateKey } from '@/lib/stats';

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

// rangeEnd is inclusive — the current year stops at today, a past year
// stops at Dec 31.
function buildGrid(counts: Map<string, number>, year: number, rangeEnd: Date) {
  const startDate = new Date(year, 0, 1);
  const totalDays = Math.round((rangeEnd.getTime() - startDate.getTime()) / MS_PER_DAY) + 1;

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

  // Same "was the most recent interaction touch" trick used for the deck
  // list's own name tooltip (app/page.tsx) — matchMedia's (hover: hover)/
  // (pointer: fine) turned out unreliable for this in both directions, so
  // instead just track whichever kind of event actually fired most
  // recently. A touch always fires touchstart before the synthetic
  // mouseenter/click a mobile browser adds for click compatibility, so this
  // flag suppresses exactly those and only those.
  const justTouchedRef = useRef(false);
  const touchFlagTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleCellTouchStart() {
    justTouchedRef.current = true;
    if (touchFlagTimeoutRef.current) clearTimeout(touchFlagTimeoutRef.current);
    touchFlagTimeoutRef.current = setTimeout(() => {
      justTouchedRef.current = false;
    }, 500);
  }

  function showTooltipForCell(cell: GridCell, targetEl: HTMLElement) {
    if (cell.blank) return;
    const rect = targetEl.getBoundingClientRect();
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
  }

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
  // Tracks which year we last auto-scrolled for, so switching years always
  // jumps to that year's most recent edge once, but a routine live-query
  // refresh within the *same* year (e.g. a review logged elsewhere) doesn't
  // keep yanking a manually-scrolled-left view back to the right.
  const lastAutoScrolledYearRef = useRef<number | null>(null);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentYear = today.getFullYear();

  const [selectedYear, setSelectedYear] = useState(currentYear);

  // Every year with at least one review, plus the current year itself even
  // if it has none yet (so the default view is never treated as "empty and
  // skippable" the moment a fresh year starts) — this is what prev/next
  // step between, so an empty past year is never landed on.
  const yearsWithReviews = useLiveQuery(() => getYearsWithReviews(), []);
  const navigableYears = useMemo(() => {
    const years = new Set(yearsWithReviews ?? []);
    years.add(currentYear);
    return Array.from(years).sort((a, b) => a - b);
  }, [yearsWithReviews, currentYear]);
  const selectedIndex = navigableYears.indexOf(selectedYear);
  const prevYear = selectedIndex > 0 ? navigableYears[selectedIndex - 1] : null;
  const nextYear =
    selectedIndex >= 0 && selectedIndex < navigableYears.length - 1 ? navigableYears[selectedIndex + 1] : null;

  const rangeEnd = selectedYear === currentYear ? today : new Date(selectedYear, 11, 31);
  const rangeStartMs = new Date(selectedYear, 0, 1).getTime();
  const rangeEndMs = rangeEnd.getTime() + MS_PER_DAY; // exclusive upper bound

  const counts = useLiveQuery(
    () => getDailyReviewCounts(rangeStartMs, rangeEndMs),
    [rangeStartMs, rangeEndMs]
  );

  // Jumps to the far right (the year's most recent activity) once per
  // year selection, not on every incidental live-query refresh.
  useLayoutEffect(() => {
    if (!counts || !scrollRef.current) return;
    if (lastAutoScrolledYearRef.current === selectedYear) return;
    scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    lastAutoScrolledYearRef.current = selectedYear;
  }, [counts, selectedYear]);

  if (!counts) return null;

  const { cells, monthLabels, totalColumns } = buildGrid(counts, selectedYear, rangeEnd);
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  const rowTemplate = '12px repeat(7, 10px)';

  return (
    <>
      <div ref={containerRef}>
        <div className="mb-2 flex items-center justify-between gap-1 text-xs text-neutral-500">
          <p>
            {total} reviews in {selectedYear}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => prevYear !== null && setSelectedYear(prevYear)}
              disabled={prevYear === null}
              aria-label="Previous year with reviews"
              className="text-neutral-500 hover:text-neutral-200 disabled:opacity-30 disabled:hover:text-neutral-500"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={() => nextYear !== null && setSelectedYear(nextYear)}
              disabled={nextYear === null}
              aria-label="Next year with reviews"
              className="text-neutral-500 hover:text-neutral-200 disabled:opacity-30 disabled:hover:text-neutral-500"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
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
                  onTouchStart={handleCellTouchStart}
                  onClick={(e) => {
                    // Desktop click: hover (below) already handles it, so a
                    // plain click does nothing there — only act when this
                    // click was actually preceded by a touchstart.
                    if (!justTouchedRef.current) return;
                    showTooltipForCell(cell, e.currentTarget);
                  }}
                  onMouseEnter={(e) => {
                    if (justTouchedRef.current || cell.blank) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip({
                      key: cell.key,
                      text: cell.title,
                      cellLeft: rect.left,
                      cellTop: rect.top,
                      cellRight: rect.right,
                      cellBottom: rect.bottom,
                    });
                  }}
                  onMouseLeave={() => {
                    if (justTouchedRef.current) return;
                    setTooltip((prev) => (prev?.key === cell.key ? null : prev));
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
