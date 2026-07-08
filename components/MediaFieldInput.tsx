'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Mic,
  CircleStop,
  AudioLines,
  X,
  Crop,
  Bold,
  Italic,
  Underline,
  EyeDashed,
  ChevronDown,
  Type,
  ListChecks,
  type LucideIcon,
} from 'lucide-react';
import { db, type FieldType, type FieldTypeConfig, type TextFormat } from '@/lib/db';
import { sanitizeRichText, stripHtml } from '@/lib/sanitize';
import { shouldDropUp } from '@/lib/dropdownMenu';
import { RichText } from './RichText';
import { RichTextInput } from './RichTextInput';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  richtext: 'Text',
  image: 'Image',
  audio: 'Audio',
  choice: 'Choice',
};

const FIELD_TYPE_ICONS: Record<FieldType, LucideIcon> = {
  richtext: Type,
  image: ImageIcon,
  audio: AudioLines,
  choice: ListChecks,
};

const ALL_FIELD_TYPES: FieldType[] = ['richtext', 'image', 'audio', 'choice'];

// 'dynamic' defers to a per-note choice among these three — deliberately
// excludes 'choice', since a choice field's option list is declared once on
// the note type (NoteType.fieldChoices) and has no meaning without that
// fixed context, so it can't be one of several kinds a single note toggles
// between.
const DYNAMIC_FIELD_TYPES: FieldType[] = ['richtext', 'image', 'audio'];

/** 3-way (or, for an 'asset' field, 2-way image/audio-only) toggle for a
 * per-note deferred field — chooses what kind of widget that one field
 * shows for this specific note. Icon-only to keep the row compact; the
 * label still carries the accessible name. */
export function FieldTypeToggle({
  value,
  onChange,
  types = DYNAMIC_FIELD_TYPES,
}: {
  value: FieldType;
  onChange: (type: FieldType) => void;
  types?: FieldType[];
}) {
  return (
    <div className="flex gap-1">
      {types.map((type) => {
        const Icon = FIELD_TYPE_ICONS[type];
        return (
          <button
            key={type}
            type="button"
            onClick={() => onChange(type)}
            aria-label={FIELD_TYPE_LABELS[type]}
            title={FIELD_TYPE_LABELS[type]}
            className={`rounded p-1 ${
              value === type
                ? 'bg-neutral-700 text-neutral-100'
                : 'border border-neutral-700 text-neutral-400'
            }`}
          >
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}

/** 6-way selector used only in the note-type editor, declaring a field's
 * fixed type — or 'dynamic'/'asset', deferring the choice to each
 * individual note (same behavior as Basic's Front/Back; 'asset' is that
 * same deferred choice narrowed to just image/audio). 'choice' is
 * fixed-only: its option list lives on the note type, not on any one note,
 * so it has no dynamic equivalent. Icon-only for the concrete types to keep
 * the row compact; 'asset'/'dynamic' stay text since they're not really a
 * single depictable "kind" of content. */
export function FieldTypeConfigToggle({
  value,
  onChange,
}: {
  value: FieldTypeConfig;
  onChange: (type: FieldTypeConfig) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]">
      {ALL_FIELD_TYPES.map((type) => {
        const Icon = FIELD_TYPE_ICONS[type];
        return (
          <button
            key={type}
            type="button"
            onClick={() => onChange(type)}
            aria-label={FIELD_TYPE_LABELS[type]}
            title={FIELD_TYPE_LABELS[type]}
            className={`flex h-[22px] w-[22px] items-center justify-center rounded ${
              value === type
                ? 'bg-neutral-700 text-neutral-100'
                : 'border border-neutral-700 text-neutral-400'
            }`}
          >
            <Icon size={14} />
          </button>
        );
      })}
      {(['asset', 'dynamic'] as const).map((type) => (
        <button
          key={type}
          type="button"
          onClick={() => onChange(type)}
          className={`flex h-[22px] items-center justify-center rounded px-1.5 ${
            value === type
              ? 'bg-neutral-700 text-neutral-100'
              : 'border border-neutral-700 text-neutral-400'
          }`}
        >
          {type === 'dynamic' ? 'Dynamic' : 'Asset'}
        </button>
      ))}
    </div>
  );
}

const SOLE_IMG_RE = /^<img\b[^>]*>$/i;
const SOLE_AUDIO_RE = /^<audio\b[^>]*>(?:<\/audio>)?$/i;

/** Infers a field's current type from its stored content — used for Basic's
 * Front/Back and "dynamic" custom fields, neither of which have a persisted
 * type to read instead. Anything that isn't exactly one bare `<img>`/`<audio>`
 * tag (e.g. real rich text, or empty) is treated as rich text. */
export function inferFieldType(html: string): FieldType {
  const trimmed = html.trim();
  if (SOLE_IMG_RE.test(trimmed)) return 'image';
  if (SOLE_AUDIO_RE.test(trimmed)) return 'audio';
  return 'richtext';
}

/** Reads a media field's label — alt on <img>, title on <audio> — decoded
 * via the DOM (not a regex) so any escaped entities (&amp; etc.) come back
 * as real characters, both for display in the label input and for the
 * "has content" check below. */
function extractMediaLabel(html: string): string {
  if (typeof document === 'undefined') return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  const el = template.content.querySelector('img, audio');
  if (!el) return '';
  return (el.tagName === 'IMG' ? el.getAttribute('alt') : el.getAttribute('title')) ?? '';
}

/** Rewrites a media field's label in place, keeping the same data-media-id
 * (and letting sanitizeRichText regenerate everything else — src, controls,
 * etc. — exactly as it would for a freshly-queued value). Building via DOM
 * APIs rather than string interpolation means the label's own escaping
 * (quotes, &, <, >) is handled correctly by the browser, not by hand. */
function setMediaLabel(html: string, label: string): string {
  const id = html.match(/data-media-id="([^"]+)"/)?.[1];
  if (!id) return html;
  const isAudio = /^<audio\b/i.test(html.trim());
  const el = document.createElement(isAudio ? 'audio' : 'img');
  el.setAttribute('data-media-id', id);
  el.setAttribute(isAudio ? 'title' : 'alt', label);
  return sanitizeRichText(el.outerHTML);
}

// Zero-width space — the caret-holding marker RichTextInput's dim toggle
// (and a note type's field-template seeding, see RichTextInput's
// initialFormat) inserts so an otherwise-empty formatting span still has a
// text node to anchor a collapsed caret in. `.trim()` alone doesn't strip
// it (it isn't standard whitespace), so a field that was only ever
// auto-formatted but never actually typed into would otherwise misreport
// as "has content".
const ZERO_WIDTH_SPACE_RE = /\u200B/g;

/** A field "has content" differently depending on its type: stripHtml on a
 * bare <img>/<audio> tag always yields empty text, so that check only
 * applies to rich text and choice (whose value is always plain text — the
 * picked option). A media field also isn't "complete" without its label —
 * that's what makes it findable in search/browse, so it's required whenever
 * media is actually attached. */
export function fieldHasContent(html: string, type: FieldType): boolean {
  if (type === 'richtext' || type === 'choice') {
    return !!stripHtml(html).replace(ZERO_WIDTH_SPACE_RE, '').trim();
  }
  if (!html.trim()) return false;
  return !!extractMediaLabel(html).trim();
}

/** True when a media field has an image/audio attached but is missing its
 * required label — distinct from fieldHasContent's false, which also covers
 * "nothing attached at all" and shouldn't be reported as a label problem.
 * Choice fields have no label concept — the picked option text is already
 * what's searchable. */
export function fieldNeedsLabel(html: string, type: FieldType): boolean {
  if (type === 'richtext' || type === 'choice') return false;
  if (!html.trim()) return false;
  return !extractMediaLabel(html).trim();
}

/** Reconciles a note's stored field values against its note type's *current*
 * field list/types when opening it for editing — the note type can change
 * after notes of that type already exist (fields renamed, or a fixed
 * field's declared type changed), and there's no migration of already-saved
 * note data when that happens. Rather than silently rendering stale/
 * mismatched content through the wrong widget:
 *  - a field name no longer in the note type (renamed or removed) is
 *    dropped entirely — its old value never carries forward;
 *  - a field name with no stored value yet (newly added, or the new side of
 *    a rename) starts empty, same as any new field;
 *  - a *fixed*-type field whose stored content no longer matches its
 *    current declared type (e.g. was Image, the type is now Rich text) is
 *    cleared — the user has to re-enter it before saving. Dynamic and asset
 *    fields have no fixed type to mismatch against, so their stored value
 *    always carries forward as-is. A choice field is cleared the same way
 *    if its stored value is no longer one of the type's current options
 *    (renamed or removed since the note was saved). */
export function reconcileFieldValues(
  storedFields: Record<string, string>,
  noteType: {
    fields: string[];
    fieldTypes: Record<string, FieldTypeConfig>;
    fieldChoices?: Record<string, string[]>;
  }
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const fieldName of noteType.fields) {
    const config = noteType.fieldTypes[fieldName] ?? 'richtext';
    const stored = storedFields[fieldName];
    if (stored === undefined) {
      result[fieldName] = '';
    } else if (config === 'dynamic' || config === 'asset') {
      result[fieldName] = stored;
    } else if (config === 'choice') {
      const options = noteType.fieldChoices?.[fieldName] ?? [];
      result[fieldName] = options.includes(stripHtml(stored)) ? stored : '';
    } else {
      result[fieldName] = inferFieldType(stored) === config ? stored : '';
    }
  }
  return result;
}

async function queueMedia(kind: 'image' | 'audio', blob: Blob): Promise<string> {
  const id = crypto.randomUUID();
  await db.pendingMedia.add({ id, kind, blob, createdAt: Date.now(), committed: false });
  const markerId = `pending:${id}`;
  const html =
    kind === 'image'
      ? `<img data-media-id="${markerId}">`
      : `<audio data-media-id="${markerId}" controls></audio>`;
  return sanitizeRichText(html);
}

// Resolves a field's own src directly from its stored value, independent of
// RichText's rendering/rehydration lifecycle — used for re-cropping so it
// never depends on some other component's internal DOM timing. Always
// returns a URL this caller itself is responsible for (a fresh blob: URL for
// a still-pending upload, revoked by the caller when done; a plain
// same-origin path for an already-uploaded one, where revoking is a no-op).
async function resolveMediaSrc(value: string): Promise<string | null> {
  const match = value.match(/data-media-id="([^"]+)"/);
  if (!match) return null;
  const id = match[1];
  if (id.startsWith('pending:')) {
    const row = await db.pendingMedia.get(id.slice('pending:'.length));
    return row ? URL.createObjectURL(row.blob) : null;
  }
  return `/api/media/${id}`;
}

interface FieldInputProps {
  value: string;
  onChange: (html: string) => void;
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  frameStart: CropRect;
}

const HANDLE_POSITIONS: Record<'nw' | 'ne' | 'sw' | 'se', string> = {
  nw: '-left-1.5 -top-1.5 cursor-nwse-resize',
  ne: '-right-1.5 -top-1.5 cursor-nesw-resize',
  sw: '-left-1.5 -bottom-1.5 cursor-nesw-resize',
  se: '-right-1.5 -bottom-1.5 cursor-nwse-resize',
};

// A frame with draggable corner handles, defaulting to a centered box over
// most of the image — drag a corner to resize, drag inside to move.
function ImageCropModal({
  src,
  onCancel,
  onConfirm,
}: {
  src: string;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [frame, setFrame] = useState<CropRect | null>(null);
  const [busy, setBusy] = useState(false);

  function handleImageLoad() {
    const container = containerRef.current;
    if (!container) return;
    // Default to the whole image selected — the user shrinks the frame to
    // crop, rather than starting from an arbitrary partial selection.
    const { clientWidth: w, clientHeight: h } = container;
    setFrame({ x: 0, y: 0, w, h });
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
    const bounds = { width: container.clientWidth, height: container.clientHeight };

    if (drag.mode === 'move') {
      const dx = pos.x - drag.startX;
      const dy = pos.y - drag.startY;
      const x = Math.min(Math.max(drag.frameStart.x + dx, 0), bounds.width - drag.frameStart.w);
      const y = Math.min(Math.max(drag.frameStart.y + dy, 0), bounds.height - drag.frameStart.h);
      setFrame({ ...drag.frameStart, x, y });
      return;
    }

    // Resizing: the corner diagonally opposite the one being dragged stays
    // fixed; the dragged corner just follows the pointer.
    const fixedX = drag.mode.includes('w') ? drag.frameStart.x + drag.frameStart.w : drag.frameStart.x;
    const fixedY = drag.mode.includes('n') ? drag.frameStart.y + drag.frameStart.h : drag.frameStart.y;
    const x = Math.max(0, Math.min(pos.x, fixedX));
    const y = Math.max(0, Math.min(pos.y, fixedY));
    const w = Math.max(4, Math.min(Math.abs(pos.x - fixedX), bounds.width - x));
    const h = Math.max(4, Math.min(Math.abs(pos.y - fixedY), bounds.height - y));
    setFrame({ x, y, w, h });
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  async function handleConfirm() {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container || !frame) return;
    setBusy(true);
    try {
      const scaleX = img.naturalWidth / container.clientWidth;
      const scaleY = img.naturalHeight / container.clientHeight;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(frame.w * scaleX);
      canvas.height = Math.round(frame.h * scaleY);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(
        img,
        frame.x * scaleX,
        frame.y * scaleY,
        frame.w * scaleX,
        frame.h * scaleY,
        0,
        0,
        canvas.width,
        canvas.height
      );
      canvas.toBlob((blob) => {
        if (blob) onConfirm(blob);
      }, 'image/png');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onCancel}>
      <div
        className="flex w-full max-w-sm flex-col max-h-[90vh] rounded-lg border border-neutral-800 bg-neutral-950 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 shrink-0 text-sm font-medium">Crop image</p>
        <div
          ref={containerRef}
          className="relative touch-none overflow-hidden rounded-md mx-auto"
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            className="block max-h-[calc(90vh-140px)] w-auto max-w-full"
            draggable={false}
            onLoad={handleImageLoad}
          />
          {frame && (
            <div
              className="absolute cursor-move border-2 border-orange-400 bg-orange-400/10"
              style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
              onPointerDown={(e) => startDrag('move', e)}
            >
              {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                <div
                  key={corner}
                  onPointerDown={(e) => startDrag(corner, e)}
                  className={`absolute h-3 w-3 rounded-full border-2 border-orange-400 bg-neutral-950 ${HANDLE_POSITIONS[corner]}`}
                />
              ))}
            </div>
          )}
        </div>
        <p className="mt-2 shrink-0 text-xs text-neutral-500">Drag the corners to resize, or drag inside to move.</p>
        <div className="mt-3 flex shrink-0 gap-2">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
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

export function ImageFieldInput({ value, onChange }: FieldInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  // Every cropSrc we ever set is one we created ourselves via
  // resolveMediaSrc/createObjectURL, so it's always safe (and always
  // correct) to revoke it here — revoking a plain /api/media/ path (the
  // already-uploaded case) is a documented no-op, not an error.
  function closeCropModal() {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setError('Image is too large (max 8 MB).');
      return;
    }
    setError('');
    setCropSrc(URL.createObjectURL(file));
  }

  async function openRecrop() {
    const src = await resolveMediaSrc(value);
    if (src) setCropSrc(src);
  }

  async function handleCropped(blob: Blob) {
    closeCropModal();
    onChange(await queueMedia('image', blob));
  }

  if (value) {
    const label = extractMediaLabel(value);
    // setMediaLabel always rebuilds the element from just the media id, so
    // this is identical across every keystroke in the label input below —
    // RichText's own diffing then sees an unchanged string and never
    // touches the DOM. Passing `value` (which changes every keystroke)
    // directly would tear down and recreate the <img> node each time,
    // which was visibly flickering and dragging the scroll position along
    // with it.
    const previewValue = setMediaLabel(value, '');
    return (
      <div className="my-3">
        <div className="relative inline-block">
          <RichText html={previewValue} />
          <div className="absolute right-2 top-2 flex items-center rounded-full bg-neutral-800/90 text-neutral-300">
            <button
              type="button"
              onClick={openRecrop}
              aria-label="Crop image"
              className="rounded-l-full p-1 hover:text-neutral-100"
            >
              <Crop size={12} />
            </button>
            <div className="h-3 w-px bg-neutral-600" />
            <button
              type="button"
              onClick={() => onChange('')}
              aria-label="Remove image"
              className="rounded-r-full p-1 hover:text-neutral-100"
            >
              <X size={12} />
            </button>
          </div>
        </div>
        <input
          value={label}
          onChange={(e) => onChange(setMediaLabel(value, e.target.value))}
          placeholder="Describe this image (required)"
          className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        {cropSrc && (
          <ImageCropModal src={cropSrc} onCancel={closeCropModal} onConfirm={handleCropped} />
        )}
      </div>
    );
  }

  return (
    <div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex h-24 w-full items-center justify-center gap-2 rounded-md border border-dashed border-neutral-700 text-sm text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
      >
        <ImageIcon size={16} /> Add image
      </button>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {cropSrc && (
        <ImageCropModal src={cropSrc} onCancel={closeCropModal} onConfirm={handleCropped} />
      )}
    </div>
  );
}

export function AudioFieldInput({ value, onChange }: FieldInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function saveBlob(blob: Blob) {
    if (blob.size > MAX_AUDIO_BYTES) {
      setError('Audio is too large (max 15 MB).');
      return;
    }
    setError('');
    onChange(await queueMedia('audio', blob));
  }

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        void saveBlob(new Blob(chunksRef.current, { type: recorder.mimeType }));
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError('Microphone access was denied or unavailable.');
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await saveBlob(file);
  }

  if (value) {
    const label = extractMediaLabel(value);
    // See ImageFieldInput's identical comment: keeps the <audio> DOM node
    // stable (and playback uninterrupted) while typing the label.
    const previewValue = setMediaLabel(value, '');
    return (
      <div className="my-3">
        <div className="relative">
          <RichText html={previewValue} />
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Remove audio"
            className="absolute right-0 top-0 rounded-full bg-neutral-800/90 p-1 text-neutral-300 hover:text-neutral-100"
          >
            <X size={12} />
          </button>
        </div>
        <input
          value={label}
          onChange={(e) => onChange(setMediaLabel(value, e.target.value))}
          placeholder="Describe this audio (required)"
          className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => (recording ? stopRecording() : startRecording())}
          aria-label={recording ? 'Stop recording' : 'Record audio'}
          className={`flex h-24 w-24 shrink-0 items-center justify-center rounded-md border ${
            recording
              ? 'border-red-700 text-red-400'
              : 'border-neutral-700 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
          }`}
        >
          {recording ? <CircleStop size={20} /> : <Mic size={20} />}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-24 flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-neutral-700 text-sm text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
        >
          <AudioLines size={16} /> Upload audio
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

const TEXT_MIN_SIZE = 1;
const TEXT_MAX_SIZE = 5;
const TEXT_NORMAL_SIZE = 3; // unwrapped — no <span data-size> at all

export const NORMAL_TEXT_FORMAT: TextFormat = {
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  size: TEXT_NORMAL_SIZE,
};

/** Reads which of RichTextInput's effects apply to an *entire* piece of
 * stored HTML — used wherever formatting is reasoned about as a whole-string
 * property rather than a partial/live selection (a choice field's picked
 * option, a note type's per-field starter template read back off its name).
 * A selection/string with only some of its text in a given effect (e.g. one
 * word bold out of a whole name) still reads as that effect being "on" —
 * the same whole-string simplification buildFormattedText below makes when
 * writing it back. */
export function readTextFormat(html: string): TextFormat {
  if (typeof document === 'undefined' || !html.trim()) return NORMAL_TEXT_FORMAT;
  const template = document.createElement('template');
  template.innerHTML = html;
  const sizeEl = template.content.querySelector('[data-size]');
  const size = sizeEl ? Number(sizeEl.getAttribute('data-size')) : TEXT_NORMAL_SIZE;
  return {
    bold: !!template.content.querySelector('b'),
    italic: !!template.content.querySelector('i'),
    underline: !!template.content.querySelector('u'),
    dim: !!template.content.querySelector('[data-dim]'),
    size: Number.isFinite(size) ? size : TEXT_NORMAL_SIZE,
  };
}

/** Rebuilds a whole-string HTML value by wrapping plain text in the given
 * format, from the inside out — building via DOM APIs (not string
 * concatenation) so the text's own escaping is handled by the browser, same
 * reasoning as setMediaLabel above. */
export function buildFormattedText(text: string, format: TextFormat): string {
  if (!text) return '';
  let node: Node = document.createTextNode(text);
  function wrap(tag: string, attrs?: Record<string, string>) {
    const el = document.createElement(tag);
    if (attrs) for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, val);
    el.appendChild(node);
    node = el;
  }
  if (format.size !== TEXT_NORMAL_SIZE) wrap('span', { 'data-size': String(format.size) });
  if (format.dim) wrap('span', { 'data-dim': '' });
  if (format.underline) wrap('u');
  if (format.italic) wrap('i');
  if (format.bold) wrap('b');
  const container = document.createElement('div');
  container.appendChild(node);
  return sanitizeRichText(container.innerHTML);
}

/** Dropdown for a 'choice' field, plus a toolbar of the same rich text
 * effects RichTextInput offers (bold/italic/underline/dim/size) — but
 * applied to the whole picked option at once rather than a selection, since
 * a choice field's value is never partial text. Its option list is declared
 * once on the note type (see NoteType.fieldChoices), not per-note, so
 * options are always passed in rather than derived from `value`.
 * `templateFormat`, when given, is the format an as-yet-unpicked field
 * starts from (see NoteType.fieldTemplates) — once an option is actually
 * picked, the format read back off the stored value takes over. */
export function ChoiceFieldInput({
  value,
  onChange,
  options,
  templateFormat,
}: FieldInputProps & { options: string[]; templateFormat?: TextFormat }) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const selected = stripHtml(value);
  const hasSelection = !!selected && options.includes(selected);
  const format = hasSelection ? readTextFormat(value) : templateFormat ?? NORMAL_TEXT_FORMAT;

  function applyFormat(patch: Partial<TextFormat>) {
    onChange(buildFormattedText(selected, { ...format, ...patch }));
  }

  function stepSize(delta: number) {
    const next = Math.min(TEXT_MAX_SIZE, Math.max(TEXT_MIN_SIZE, format.size + delta));
    if (next !== format.size) applyFormat({ size: next });
  }

  function pickOption(option: string) {
    onChange(buildFormattedText(option, format));
    setOpen(false);
  }

  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900">
      <div className="flex gap-1 border-b border-neutral-700 p-1">
        <button
          type="button"
          onClick={() => applyFormat({ bold: !format.bold })}
          disabled={!hasSelection}
          aria-label="Bold"
          aria-pressed={format.bold}
          className={`rounded p-1 disabled:opacity-40 ${
            format.bold
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          onClick={() => applyFormat({ italic: !format.italic })}
          disabled={!hasSelection}
          aria-label="Italic"
          aria-pressed={format.italic}
          className={`rounded p-1 disabled:opacity-40 ${
            format.italic
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Italic size={14} />
        </button>
        <button
          type="button"
          onClick={() => applyFormat({ underline: !format.underline })}
          disabled={!hasSelection}
          aria-label="Underline"
          aria-pressed={format.underline}
          className={`rounded p-1 disabled:opacity-40 ${
            format.underline
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Underline size={14} />
        </button>
        <button
          type="button"
          onClick={() => applyFormat({ dim: !format.dim })}
          disabled={!hasSelection}
          aria-label="Dim text"
          aria-pressed={format.dim}
          className={`rounded p-1 disabled:opacity-40 ${
            format.dim
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <EyeDashed size={14} />
        </button>
        <div className="mx-1 w-px bg-neutral-700" />
        <button
          type="button"
          onClick={() => stepSize(-1)}
          disabled={!hasSelection}
          aria-label="Smaller text"
          title="Smaller text"
          className="rounded px-1.5 text-xs leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
        >
          A
        </button>
        <button
          type="button"
          onClick={() => stepSize(1)}
          disabled={!hasSelection}
          aria-label="Bigger text"
          title="Bigger text"
          className="rounded px-1.5 text-lg leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
        >
          A
        </button>
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            const opening = !open;
            setOpen(opening);
            if (opening) setDropUp(shouldDropUp(e.currentTarget.getBoundingClientRect()));
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
        >
          {hasSelection ? (
            <RichText html={value} />
          ) : (
            <span className="text-neutral-500">Select…</span>
          )}
          <ChevronDown size={14} className="shrink-0 text-neutral-500" />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              role="listbox"
              className={`absolute inset-x-0 z-50 max-h-56 overflow-auto rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-lg ${
                dropUp ? 'bottom-full mb-1' : 'top-full mt-1'
              }`}
            >
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={option === selected}
                  onClick={() => pickOption(option)}
                  className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-800 ${
                    option === selected ? 'text-neutral-100' : 'text-neutral-300'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Renders whichever widget matches a field's current type — shared by the
 * add-card modal and CardRow's edit mode so the "fixed vs dynamic" dispatch
 * logic only lives in one place. `options` is only meaningful (and required
 * to have any choices) when `type === 'choice'`. */
export function FieldValueInput({
  type,
  value,
  onChange,
  placeholder,
  options,
  templateFormat,
}: {
  type: FieldType;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  options?: string[];
  templateFormat?: TextFormat;
}) {
  if (type === 'image') return <ImageFieldInput value={value} onChange={onChange} />;
  if (type === 'audio') return <AudioFieldInput value={value} onChange={onChange} />;
  if (type === 'choice') {
    return (
      <ChoiceFieldInput
        value={value}
        onChange={onChange}
        options={options ?? []}
        templateFormat={templateFormat}
      />
    );
  }
  return (
    <RichTextInput value={value} onChange={onChange} placeholder={placeholder} initialFormat={templateFormat} />
  );
}
