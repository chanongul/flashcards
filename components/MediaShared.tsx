"use client";

// Media upload/crop/resolve primitives shared by every field that can hold
// an image or audio clip — TiptapFieldInput's inline "insert image"/"insert
// audio" toolbar actions go through exactly this code. Lives in its own
// module (not MediaFieldInput.tsx, which imports TiptapFieldInput for
// FieldValueInput's dispatch) specifically so TiptapFieldInput can import
// these without a circular import.
import { useRef, useState } from "react";
import { X } from "lucide-react";
import { db } from "@/lib/db";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

// Queues a file locally (works offline — see lib/mediaSync.ts for how a
// "pending:" marker gets swapped for the real uploaded filename once back
// online) and returns its marker id ("pending:<uuid>") for TiptapFieldInput
// to build its own inline node attrs from. Always the full, unprocessed
// file — a crop (image) or trim (audio) is pure display/playback metadata
// on the node itself, never applied to what actually gets queued/uploaded
// here, specifically so the original is always what's kept.
export async function queueMediaId(kind: "image" | "audio", blob: Blob): Promise<string> {
  const id = crypto.randomUUID();
  await db.pendingMedia.add({
    id,
    kind,
    blob,
    createdAt: Date.now(),
    committed: false,
  });
  return `pending:${id}`;
}

// Resolves a data-media-id straight to a usable src, independent of
// RichText's rendering/rehydration lifecycle — used for re-cropping and by
// TiptapFieldInput's own rehydration, so it never depends on some other
// component's internal DOM timing. Always returns a URL the caller is
// responsible for (a fresh blob: URL for a still-pending upload, revoked by
// the caller when done; a plain same-origin path for an already-uploaded
// one, where revoking is a no-op).
export async function resolveMediaSrcById(id: string): Promise<string | null> {
  if (id.startsWith("pending:")) {
    const row = await db.pendingMedia.get(id.slice("pending:".length));
    return row ? URL.createObjectURL(row.blob) : null;
  }
  return `/api/media/${id}`;
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragMode = "move" | "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  frameStart: CropRect;
}

const HANDLE_POSITIONS: Record<"nw" | "ne" | "sw" | "se", string> = {
  nw: "-left-3 -top-3 cursor-nwse-resize",
  ne: "-right-3 -top-3 cursor-nesw-resize",
  sw: "-left-3 -bottom-3 cursor-nesw-resize",
  se: "-right-3 -bottom-3 cursor-nwse-resize",
};

// A frame with draggable corner handles, defaulting to a centered box over
// most of the image — drag a corner to resize, drag inside to move. Also
// where the required alt text gets entered — asked for right here, before
// the image can be added at all, rather than after the fact (see
// TiptapFieldInput's insertImage/handleCropped): an image that already
// went in unlabeled and unblocked used to just sit there until submit-time
// validation caught it (fieldNeedsLabel) — cheaper to just never let it in
// without one.
//
// Non-destructive: this used to draw the cropped region to a canvas and
// hand back a new, already-cropped Blob — now it just reports the frame as
// fractions (0-1) of the *displayed* image, which are resolution-
// independent (identical whether the image is shown at its natural size or
// scaled down to fit the modal) and so equally valid as fractions of the
// original's natural size. TiptapFieldInput stores these directly as
// node attrs; nothing here ever touches the original image's own pixels —
// see MediaImage's own cropX/Y/Width/Height doc comment in
// lib/tiptapExtensions.ts for why (the original is always kept, on
// request, rather than a crop permanently discarding the rest of it).
export function ImageCropModal({
  src,
  initialAlt = "",
  initialCrop = null,
  onCancel,
  onConfirm,
}: {
  src: string;
  initialAlt?: string;
  // The node's *existing* crop, if any (fractions 0-1) — preloads the
  // frame to where a previous crop left off instead of always restarting
  // from the whole image.
  initialCrop?: CropRect | null;
  onCancel: () => void;
  // crop is null when the frame was left covering the whole image (an
  // untouched default, or deliberately reset back to it) — sent as null
  // rather than a redundant {0,0,1,1}, same "don't bother storing a no-op"
  // convention AudioEditModal's own trim uses.
  onConfirm: (crop: CropRect | null, alt: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [frame, setFrame] = useState<CropRect | null>(null);
  const [alt, setAlt] = useState(initialAlt);

  function handleImageLoad() {
    const container = containerRef.current;
    if (!container) return;
    const { clientWidth: w, clientHeight: h } = container;
    if (initialCrop) {
      setFrame({ x: initialCrop.x * w, y: initialCrop.y * h, w: initialCrop.w * w, h: initialCrop.h * h });
    } else {
      // Default to the whole image selected — the user shrinks the frame
      // to crop, rather than starting from an arbitrary partial selection.
      setFrame({ x: 0, y: 0, w, h });
    }
  }

  function relativePos(e: React.PointerEvent): { x: number; y: number } {
    const bounds = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - bounds.left, 0), bounds.width),
      y: Math.min(Math.max(e.clientY - bounds.top, 0), bounds.height),
    };
  }

  function startDrag(mode: DragMode, e: React.PointerEvent) {
    if (!frame) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const pos = relativePos(e);
    dragRef.current = { mode, startX: pos.x, startY: pos.y, frameStart: frame };
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container) return;
    const pos = relativePos(e);
    const bounds = {
      width: container.clientWidth,
      height: container.clientHeight,
    };

    if (drag.mode === "move") {
      const dx = pos.x - drag.startX;
      const dy = pos.y - drag.startY;
      const x = Math.min(
        Math.max(drag.frameStart.x + dx, 0),
        bounds.width - drag.frameStart.w,
      );
      const y = Math.min(
        Math.max(drag.frameStart.y + dy, 0),
        bounds.height - drag.frameStart.h,
      );
      setFrame({ ...drag.frameStart, x, y });
      return;
    }

    // Resizing: the corner diagonally opposite the one being dragged stays
    // fixed; the dragged corner just follows the pointer.
    const fixedX = drag.mode.includes("w")
      ? drag.frameStart.x + drag.frameStart.w
      : drag.frameStart.x;
    const fixedY = drag.mode.includes("n")
      ? drag.frameStart.y + drag.frameStart.h
      : drag.frameStart.y;
    const x = Math.max(0, Math.min(pos.x, fixedX));
    const y = Math.max(0, Math.min(pos.y, fixedY));
    const w = Math.max(4, Math.min(Math.abs(pos.x - fixedX), bounds.width - x));
    const h = Math.max(
      4,
      Math.min(Math.abs(pos.y - fixedY), bounds.height - y),
    );
    setFrame({ x, y, w, h });
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  function handleConfirm() {
    const container = containerRef.current;
    if (!container || !frame) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const x = frame.x / cw;
    const y = frame.y / ch;
    const w = frame.w / cw;
    const h = frame.h / ch;
    // Small tolerance, not an exact 0/1 check — a frame the user never
    // touched (or dragged back out to the edges) won't land on those exact
    // pixel values every time.
    const isWholeImage = x <= 0.01 && y <= 0.01 && w >= 0.99 && h >= 0.99;
    onConfirm(isWholeImage ? null : { x, y, w, h }, alt.trim());
  }

  return (
    <div className="fixed inset-0 z-[60] flex cursor-default items-center justify-center bg-black/70 p-4">
      <div className="flex w-full max-w-sm flex-col max-h-[90vh] rounded-lg border border-neutral-800 bg-neutral-950 p-4">
        <div className="mb-2 flex shrink-0 items-center justify-between">
          <p className="text-sm font-medium">Crop image</p>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="text-neutral-400 hover:text-neutral-200"
          >
            <X size={16} />
          </button>
        </div>
        {/* No overflow-hidden here (an earlier version had one) — it was
            clipping the corner handles below whenever the crop frame sat
            near the container's own edge, which is exactly where the
            default "whole image selected" frame starts. The rounded
            corners that overflow-hidden was for now come from the img
            itself instead. */}
        <div
          ref={containerRef}
          className="relative touch-none mx-auto"
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <img
            src={src}
            alt=""
            className="block max-h-[calc(90vh-140px)] w-auto max-w-full rounded-md"
            draggable={false}
            onLoad={handleImageLoad}
          />
          {frame && (
            <div
              className="absolute cursor-move border-2 border-orange-400 bg-orange-400/10"
              style={{
                left: frame.x,
                top: frame.y,
                width: frame.w,
                height: frame.h,
              }}
              onPointerDown={(e) => startDrag("move", e)}
            >
              {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                <div
                  key={corner}
                  onPointerDown={(e) => startDrag(corner, e)}
                  className={`absolute size-6 rounded-full border-2 border-orange-400 bg-neutral-950 ${HANDLE_POSITIONS[corner]}`}
                />
              ))}
            </div>
          )}
        </div>
        <p className="mt-2 shrink-0 text-xs text-neutral-500">
          Drag the corners to resize, or drag inside to move.
        </p>
        <input
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          placeholder="Describe this image (required)"
          className="mt-2 w-full shrink-0 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!alt.trim()}
            className="flex-1 rounded-md bg-neutral-100 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-50"
          >
            Use image
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md border border-neutral-700 py-1.5 text-xs text-neutral-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// A tap on an already-selected image (ImageNodeView) opens this instead of
// doing nothing, matching the crop button's own "select first, act second"
// two-step. Resolves its own natural size independently, the same
// self-correcting-after-load pattern ImageNodeView/RichText's own crop
// rendering already uses, rather than trusting a caller to already have it —
// keeps this reusable on its own.
export function ImagePreviewModal({
  src,
  alt,
  crop,
  onClose,
}: {
  src: string;
  alt: string;
  // Same fractions-of-the-original shape as ImageCropModal's own crop prop
  // — shows just that rectangle, enlarged, rather than the whole original
  // behind it, matching what's actually displayed in the field.
  crop: CropRect | null;
  onClose: () => void;
}) {
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  function handleLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/90 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute top-4 right-4 text-neutral-300 hover:text-white"
      >
        <X size={24} />
      </button>
      {crop ? (
        // Same non-destructive crop technique as ImageNodeView's own crop
        // wrapper (see its doc comment in TiptapFieldInput.tsx for the full
        // algebra) — just scaled to fit the viewport instead of the field.
        // `min(90vw, 90vh * ratio)` sizes the wrapper as large as possible
        // within both viewport bounds while keeping the crop's own real
        // aspect ratio — a pure-CSS fit-within-box-preserving-ratio that
        // doesn't need a resize listener, unlike computing pixels in JS.
        <span
          className="relative block cursor-default overflow-hidden rounded-md"
          style={{
            width: naturalSize
              ? `min(90vw, calc(90vh * ${(crop.w * naturalSize.w) / (crop.h * naturalSize.h)}))`
              : `min(90vw, calc(90vh * ${crop.w / crop.h}))`,
            aspectRatio: naturalSize
              ? `${crop.w * naturalSize.w} / ${crop.h * naturalSize.h}`
              : `${crop.w} / ${crop.h}`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={src}
            alt={alt}
            onLoad={handleLoad}
            style={{
              position: 'absolute',
              width: `${100 / crop.w}%`,
              height: 'auto',
              left: `${-(crop.x / crop.w) * 100}%`,
              top: `${-(crop.y / crop.h) * 100}%`,
              maxWidth: 'none',
            }}
            draggable={false}
          />
        </span>
      ) : (
        <img
          src={src}
          alt={alt}
          className="max-h-[90vh] max-w-[90vw] cursor-default rounded-md object-contain"
          onClick={(e) => e.stopPropagation()}
          draggable={false}
        />
      )}
    </div>
  );
}
