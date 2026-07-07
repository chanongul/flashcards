'use client';

import { useEffect, useRef, useState } from 'react';
import { Type, PenTool, Eraser, Undo2 } from 'lucide-react';

// How many strokes (or clears) back you can undo — capped so the snapshot
// stack (one full-canvas ImageData per entry) can't grow unbounded.
const MAX_UNDO_STEPS = 20;

const STROKE_COLOR = '#e5e5e5'; // neutral-200, readable on the neutral-950 canvas bg

/** A scratchpad for working through a card before revealing the answer —
 * type or draw, purely in-memory, never persisted anywhere. Mounted fresh
 * per card (the caller keys it by card id), so there's no reset logic to
 * write here at all; a new mount is already a blank pad. Both the text and
 * the drawing stay mounted simultaneously (toggled by visibility, not
 * conditional rendering) so switching tabs never loses whichever one
 * you're not currently looking at. */
export function JotPad() {
  const [mode, setMode] = useState<'type' | 'draw'>('type');
  const [text, setText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const [canUndo, setCanUndo] = useState(false);

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
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      // A resize already wipes the canvas's own pixels, and any snapshot
      // taken at the old dimensions can't be restored onto the new ones —
      // drop the stack rather than leave undo pointing at stale sizes.
      undoStackRef.current = [];
      setCanUndo(false);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

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
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) return;
    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStackRef.current.length > MAX_UNDO_STEPS) undoStackRef.current.shift();
    setCanUndo(true);
  }

  function handleUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const snapshot = undoStackRef.current.pop();
    if (!canvas || !ctx || !snapshot) return;
    ctx.putImageData(snapshot, 0, 0);
    setCanUndo(undoStackRef.current.length > 0);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    pushUndoSnapshot();
    drawingRef.current = true;
    lastPointRef.current = pointerPos(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    const from = lastPointRef.current;
    if (!ctx || !from) return;
    const to = pointerPos(e);
    ctx.strokeStyle = STROKE_COLOR;
    ctx.lineWidth = 3 * (window.devicePixelRatio || 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
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
    if (mode === 'type') {
      setText('');
      return;
    }
    pushUndoSnapshot();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return (
    <div className="flex h-full flex-col rounded-md border border-neutral-800 bg-neutral-900/60 p-2 backdrop-blur-sm">
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMode('type')}
            aria-label="Type"
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
              mode === 'type' ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Type size={12} /> Type
          </button>
          <button
            type="button"
            onClick={() => setMode('draw')}
            aria-label="Draw"
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
              mode === 'draw' ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <PenTool size={12} /> Draw
          </button>
        </div>
        <div className="flex gap-1">
          {mode === 'draw' && (
            <button
              type="button"
              onClick={handleUndo}
              disabled={!canUndo}
              aria-label="Undo last stroke"
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-30 disabled:hover:text-neutral-500"
            >
              <Undo2 size={12} /> Undo
            </button>
          )}
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear jot"
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300"
          >
            <Eraser size={12} /> Clear
          </button>
        </div>
      </div>

      <div ref={containerRef} className="relative w-full flex-1">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Jot something…"
          className={`absolute inset-0 h-full w-full resize-none rounded-md border border-neutral-700 bg-neutral-950/5 px-3 py-2 text-sm outline-none ${
            mode === 'type' ? '' : 'invisible'
          }`}
        />
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className={`absolute inset-0 h-full w-full touch-none rounded-md border border-neutral-700 bg-neutral-950/5 ${
            mode === 'draw' ? '' : 'invisible'
          }`}
        />
      </div>
    </div>
  );
}
