"use client";

import { useEffect, useRef, useState } from "react";
import { Type, PenTool, Eraser, Undo2, Grid2X2 } from "lucide-react";

// How many strokes (or clears) back you can undo — capped so the snapshot
// stack (one full-canvas ImageData per entry) can't grow unbounded.
const MAX_UNDO_STEPS = 20;

// Graph-paper grid, drawn as a CSS background (not baked into the canvas's
// own pixels) so it never shows up in undo/clear/getImageData — it's purely
// decorative and unaffected by drawing, resizing, or DPR.
const GRID_SIZE = 16; // px
const GRID_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
  backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
};

const STROKE_COLOR = "#e5e5e5"; // neutral-200, readable on the neutral-950 canvas bg
const LINE_WIDTH_MULTIPLIER = 2;

/** A scratchpad for working through a card before revealing the answer —
 * type or draw, purely in-memory, never persisted anywhere. Mounted fresh
 * per card (the caller keys it by card id), so there's no reset logic to
 * write here at all; a new mount is already a blank pad. Both the text and
 * the drawing stay mounted simultaneously (toggled by visibility, not
 * conditional rendering) so switching tabs never loses whichever one
 * you're not currently looking at. */
interface JotPadProps {
  sizeRatio: number;
  onSizeToggle: () => void;
  hasCard: boolean;
}

export function JotPad({ sizeRatio, onSizeToggle, hasCard }: JotPadProps) {
  const [mode, setMode] = useState<"type" | "draw">("type");
  const [text, setText] = useState("");

  // Tracks whether the canvas has any drawn content so we can warn before
  // a size change (which would clear it). Set to true on first stroke,
  // false after an explicit canvas clear or a confirmed size-change clear.
  const hasDrawingRef = useRef(false);
  // When the user clicks the size toggle while a drawing exists, we park
  // the pending toggle here and show a confirmation instead of firing
  // onSizeToggle immediately.
  const [confirmClearForSize, setConfirmClearForSize] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [showGrid, setShowGrid] = useState(true);

  // Sized off the wrapping container, not the canvas itself — the canvas is
  // only ever hidden via visibility (see the className below), never
  // display:none, specifically so it always has real layout dimensions to
  // measure here regardless of which tab is active on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const newW = Math.round(rect.width * dpr);
      const newH = Math.round(rect.height * dpr);
      // Skip if nothing changed (avoids unnecessary clears when the observer
      // fires for unrelated reasons, e.g. scrollbar appearance).
      if (canvas.width === newW && canvas.height === newH) return;

      canvas.width = newW;
      canvas.height = newH;

      // Undo snapshots were taken at the old dimensions — drop them.
      undoStackRef.current = [];
      setCanUndo(false);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    undoStackRef.current = [];
    setCanUndo(false);
    hasDrawingRef.current = false;
  }

  // Called when the user clicks the size % button. If the canvas has a
  // drawing, we pause and ask for confirmation; otherwise toggle immediately.
  function handleSizeToggleClick() {
    if (hasDrawingRef.current) {
      setConfirmClearForSize(true);
    } else {
      onSizeToggle();
    }
  }

  // User confirmed: clear the canvas and resize.
  function handleConfirmSizeChange() {
    clearCanvas();
    setConfirmClearForSize(false);
    onSizeToggle();
  }

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  // Snapshot the canvas as it stood right before a stroke (or a clear)
  // starts, so undo can restore exactly that.
  function pushUndoSnapshot() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) return;
    undoStackRef.current.push(
      ctx.getImageData(0, 0, canvas.width, canvas.height),
    );
    if (undoStackRef.current.length > MAX_UNDO_STEPS)
      undoStackRef.current.shift();
    setCanUndo(true);
  }

  function handleUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const snapshot = undoStackRef.current.pop();
    if (!canvas || !ctx || !snapshot) return;
    ctx.putImageData(snapshot, 0, 0);
    setCanUndo(undoStackRef.current.length > 0);
    // If undo empties the stack the canvas is effectively blank again.
    if (undoStackRef.current.length === 0) hasDrawingRef.current = false;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    pushUndoSnapshot();
    drawingRef.current = true;
    hasDrawingRef.current = true;
    lastPointRef.current = pointerPos(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    const from = lastPointRef.current;
    if (!ctx || !from) return;
    const to = pointerPos(e);
    ctx.strokeStyle = STROKE_COLOR;
    ctx.lineWidth = LINE_WIDTH_MULTIPLIER * (window.devicePixelRatio || 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    lastPointRef.current = to;
  }

  function handlePointerUp() {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function handleClear() {
    if (mode === "type") {
      setText("");
      return;
    }
    pushUndoSnapshot();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // After a clear the undo stack holds the pre-clear snapshot, so the
      // canvas is "not blank" from undo's perspective but IS blank visually.
      // Keep canUndo true so the user can undo the clear, but canClear should
      // reflect the visual state — track blank separately.
    }
  }

  // True when there is something to erase in the current mode.
  const canClear = mode === "type" ? text.length > 0 : canUndo;

  return (
    <div className="flex h-full flex-col rounded-md border border-neutral-800 bg-neutral-900/60 p-2 backdrop-blur-sm">
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMode("type")}
            aria-label="Type"
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
              mode === "type"
                ? "bg-neutral-700 text-neutral-100"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            <Type size={12} /> Type
          </button>
          <button
            type="button"
            onClick={() => setMode("draw")}
            aria-label="Draw"
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
              mode === "draw"
                ? "bg-neutral-700 text-neutral-100"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            <PenTool size={12} /> Draw
          </button>
          {/* Size toggler — hidden when there's no card to review */}
          {hasCard && (
            <button
              type="button"
              onClick={handleSizeToggleClick}
              aria-label="Toggle jot pad size"
              className="flex items-center rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 tabular-nums"
            >
              {Math.round(sizeRatio * 100)}%
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {mode === "draw" && (
            <>
              <button
                type="button"
                onClick={() => setShowGrid((g) => !g)}
                aria-label="Toggle grid background"
                className={`flex items-center rounded p-1 text-xs ${
                  showGrid
                    ? "text-neutral-300 hover:text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-400"
                }`}
              >
                <Grid2X2 size={16} />
              </button>
              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo}
                aria-label="Undo last stroke"
                className="flex items-center rounded p-1 text-xs text-neutral-300 hover:text-neutral-100 disabled:opacity-30 disabled:text-neutral-500"
              >
                <Undo2 size={16} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleClear}
            disabled={!canClear}
            aria-label="Clear jot"
            className="flex items-center rounded p-1 text-xs text-neutral-300 hover:text-neutral-100 disabled:opacity-30 disabled:text-neutral-500"
          >
            <Eraser size={16} />
          </button>
        </div>
      </div>

      <div ref={containerRef} className="relative w-full flex-1">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Jot something…"
          className={`absolute inset-0 h-full w-full resize-none rounded-md border border-neutral-700 bg-neutral-950/5 px-3 py-2 text-sm outline-none ${
            mode === "type" ? "" : "invisible"
          }`}
        />
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          style={showGrid ? GRID_STYLE : undefined}
          className={`absolute inset-0 h-full w-full touch-none rounded-md border border-neutral-700 bg-neutral-950/5 ${
            mode === "draw" ? "" : "invisible"
          }`}
        />
      </div>

      {/* Confirmation modal: shown when the user clicks size toggle while a drawing exists */}
      {confirmClearForSize && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setConfirmClearForSize(false)}
        >
          <div
            className="w-full max-w-xs rounded-lg border border-neutral-800 bg-neutral-950 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-1 text-sm font-medium">Change pad size?</p>
            <p className="mb-4 text-xs text-neutral-400">
              Resizing will clear your current drawing. Your typed text will be kept.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleConfirmSizeChange}
                className="flex-1 rounded-md bg-neutral-100 py-2 text-xs font-medium text-neutral-900"
              >
                Change size
              </button>
              <button
                onClick={() => setConfirmClearForSize(false)}
                className="flex-1 rounded-md border border-neutral-700 py-2 text-xs text-neutral-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
