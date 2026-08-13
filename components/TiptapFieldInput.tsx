'use client';

// The field editor for every 'richtext' field (see lib/db.ts's FieldType) —
// built on Tiptap/ProseMirror rather than a hand-rolled contentEditable
// model, replacing the old RichTextInput (now deleted). Outputs the exact
// same sanitizeRichText'd HTML shape RichTextInput did (see
// lib/tiptapExtensions.ts's doc comments), so every already-stored card's
// content, however it was originally written, needed no migration — only
// the editing widget changed, not what's on disk or how it displays.
//
// Also the ONE field widget for images and audio now — instead of a whole
// field being exclusively text, exactly one image, or exactly one audio
// clip (the old ImageFieldInput/AudioFieldInput widgets, now deleted), any
// number of images/audio can sit inline alongside text in the same field.
// The actual upload/crop/record pipeline isn't reimplemented here: it's
// the exact same code those widgets used, in components/MediaShared.tsx
// and lib/useAudioRecorder.ts, reused rather than duplicated.
import { useEditor, EditorContent, ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import type { Mark } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { Text } from '@tiptap/extension-text';
import { History } from '@tiptap/extension-history';
import { useEffect, useReducer, useRef, useState } from 'react';
import {
  Bold,
  Italic,
  Underline,
  EyeDashed,
  Baseline,
  CaseUpper,
  CaseLower,
  Undo2,
  Redo2,
  Image as ImageIcon,
  Mic,
  CircleStop,
  AudioLines,
  AudioWaveform as AudioWaveformIcon,
  Crop,
  Trash2,
  Play,
  Pause,
  X,
  Quote,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Code2,
  Minus,
  Table2,
  Rows3,
  Columns3,
  Sigma,
} from 'lucide-react';
import katex from 'katex';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions';
import { sanitizeRichText } from '@/lib/sanitize';
import type { TextFormat } from '@/lib/db';
import {
  COLOR_PALETTE,
  MIN_SIZE,
  MAX_SIZE,
  NORMAL_SIZE,
  MIN_IMAGE_WIDTH_PERCENT,
  MAX_IMAGE_WIDTH_PERCENT,
  MIN_IMAGE_HEIGHT_PX,
  MIN_AUDIO_WIDTH_PERCENT,
  MAX_AUDIO_WIDTH_PERCENT,
  type AlignValue,
  CODE_BLOCK_LANGUAGES,
} from '@/lib/richTextModel';
import { rehydratePendingMedia } from '@/lib/mediaRehydrate';
import { useAudioRecorder } from '@/lib/useAudioRecorder';
import { trimAudioBlobForPreview } from '@/lib/trimAudioPreview';
import { MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, queueMediaId, resolveMediaSrcById, ImageCropModal, ImagePreviewModal } from './MediaShared';
import {
  HardBreak,
  Bold as BoldMark,
  Italic as ItalicMark,
  Underline as UnderlineMark,
  Dim as DimMark,
  FontSize,
  TextColor,
  MediaImage,
  MediaAudio,
} from '@/lib/tiptapExtensions';
import {
  BlockDoc,
  Paragraph,
  BlockAlign,
  Blockquote,
  BulletList,
  OrderedList,
  ListItem,
  ListKeymap,
  HorizontalRule,
  CodeBlock,
  Table,
  TableRow,
  TableCell,
  TableHeader,
  BlockEssentials,
  MathInline,
  MathBlock,
  MathBridgeExtension,
} from '@/lib/tiptapBlockExtensions';
import { DropdownMenu } from './base/DropdownMenu';

// `clientWidth` includes horizontal padding (12px either side of
// .rich-text-content's own `px-3`) — but a percentage `width` on a
// descendant resolves against the CSS content-box width, which excludes
// it. Using clientWidth as the 100% basis for ImageNodeView's resize drag
// meant the two disagreed by exactly that padding, so merely pressing the
// handle and nudging it 1px would compute ~94% instead of ~100% — a
// visible, unintended shrink before any real drag intent (confirmed
// empirically). This is the same content-box distinction as the wrapper-
// carries-the-width fix in ImageNodeView's own doc comment below, just at
// one level up (the field itself, not the image's wrapper).
function contentBoxWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

// Tap-to-select, then act — a plain tap only selects the image (default
// ProseMirror click-to-select, same as any other node); nothing else shows
// up until it's actually selected, at which point this NodeView overlays a
// selection ring plus two touch-sized controls: a crop button (opens the
// modal — see editor.storage.image.openEditor below) and a drag-to-resize
// handle, top-right and bottom-right respectively. Deliberately NOT
// "tap opens the modal immediately" (an earlier version of this did) —
// on a touchscreen there's no hover state to preview what a tap will do,
// so a screen-covering modal popping up on the very first touch, with no
// chance to instead just resize, was surprising and hard to back out of.
// Selecting first and showing explicit controls is the same two-step
// pattern most touch image editors (Notion, Google Docs mobile) use for
// exactly this reason.
//
// The img itself still renders/behaves exactly as it did under Tiptap's
// own default node view (same .rich-text-content img CSS, same
// src/alt/data-media-id attrs) — this NodeView only exists to overlay the
// controls above it. The wrapper span is `inline-block` (shrink-to-fit
// around whatever size the img actually renders at) rather than `block`,
// specifically so those controls — absolutely positioned against the
// wrapper — land on the img's real corners at every width, not the
// field's full width.
//
// The wrapper, not the img, carries the percent width once one is set —
// same "give the shrink-to-fit box a definite width" fix already applied to
// the audio-only-field CSS in globals.css, for the identical circular-
// percentage problem: an inline-block box's shrink-to-fit width is supposed
// to come from its content's rendered size, but a *percentage*-width child
// has no rendered size until its container's width is already known, so
// (confirmed empirically — the resize handle stayed glued to the image's
// pre-drag position, and the next drag's start-width measurement read that
// same stale box) the browser can't actually resolve the wrapper's size
// from a percentage-width img and falls back to something that isn't the
// image's real rendered width. Once the wrapper's own width is definite
// (a percent of the field, which does NOT depend on the wrapper's own
// content), the img being 100% of that is trivially resolvable, and
// getBoundingClientRect() on the wrapper below is trustworthy again on
// every subsequent drag, not just the first.
function ImageNodeView({ node, selected, editor, getPos, updateAttributes }: ReactNodeViewProps) {
  const dragRef = useRef<{ startX: number; startWidthPx: number; containerWidth: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Snapshot of `selected` captured at pointerdown — before ProseMirror
  // sets the NodeSelection (and re-renders this component with selected=true)
  // synchronously on the same event. Without this, every first tap on an
  // unselected image would immediately open the preview, because by the time
  // the click handler runs `selected` is already true regardless of whether
  // the image was already selected before the tap.
  const wasSelectedOnPointerDownRef = useRef(false);

  const cropX = node.attrs.cropX as number | null;
  const cropY = node.attrs.cropY as number | null;
  const cropWidth = node.attrs.cropWidth as number | null;
  const cropHeight = node.attrs.cropHeight as number | null;
  const hasCrop = cropX != null && cropY != null && cropWidth != null && cropHeight != null;

  // Only actually needed for a cropped image's own wrapper aspect-ratio
  // (see the render below) — an uncropped image doesn't need this at all,
  // it just shrink-wraps to its own intrinsic size the normal way.
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  function handleImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  // The width while a drag is in progress — deliberately NOT committed to
  // the document (via updateAttributes) on every pointermove. updateAttributes
  // dispatches a ProseMirror transaction, which (confirmed empirically,
  // same as the setNodeSelection-on-pointerdown bug below) can remount this
  // NodeView mid-gesture; since pointer capture is tied to the specific DOM
  // element, a remount silently drops it, so only the very first move of a
  // drag ever took effect and every one after it was lost. Local React
  // state, by contrast, re-renders this same already-mounted component in
  // place — capture survives for the whole gesture — so it drives the live
  // visual size, and the real commit (updateAttributes) happens exactly
  // once, on release.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  // A cropped image has no "natural size" to fall back to any more than
  // audio does (see MIN/MAX_AUDIO_WIDTH_PERCENT's own doc comment) — a
  // crop is a *subset* of the original, not a whole image with its own
  // intrinsic display size, so it defaults to filling the field instead,
  // same as audio. An uncropped image keeps its existing natural-size
  // default untouched.
  const width = liveWidth ?? (node.attrs.width as number | null) ?? (hasCrop ? MAX_IMAGE_WIDTH_PERCENT : null);

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = (e.currentTarget as HTMLElement).parentElement;
    if (!wrap) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startWidthPx: wrap.getBoundingClientRect().width,
      containerWidth: contentBoxWidth(editor.view.dom),
    };
    // Deliberately NOT setNodeSelection here either (only on pointerup,
    // below) — same transaction-triggers-a-remount hazard as above, and at
    // this point in the gesture nothing has actually happened yet to
    // select.
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const widthPx = drag.startWidthPx + (e.clientX - drag.startX);
    // MIN_IMAGE_WIDTH_PERCENT alone isn't a real floor for a landscape/
    // panoramic image (or a wide crop of one) — 15% of a narrow field can
    // still come out only a few px tall once the *displayed* content's own
    // aspect ratio is applied. Raise the width floor, per-image, to
    // whatever keeps its rendered height at or above MIN_IMAGE_HEIGHT_PX —
    // using the crop rectangle's own aspect ratio when one is set (that's
    // what's actually being displayed, not the full original behind it),
    // naturalWidth/naturalHeight otherwise, not the current CSS size, so
    // this is correct however the image is currently rendered — and
    // skipped if they're not loaded yet, since a 0/0 ratio isn't
    // meaningful.
    const naturalW = imgRef.current?.naturalWidth ?? 0;
    const naturalH = imgRef.current?.naturalHeight ?? 0;
    const displayedW = hasCrop && cropWidth ? naturalW * cropWidth : naturalW;
    const displayedH = hasCrop && cropHeight ? naturalH * cropHeight : naturalH;
    const minPercent =
      displayedW > 0 && displayedH > 0
        ? Math.max(
            MIN_IMAGE_WIDTH_PERCENT,
            ((MIN_IMAGE_HEIGHT_PX * displayedW) / displayedH / drag.containerWidth) * 100
          )
        : MIN_IMAGE_WIDTH_PERCENT;
    const percent = Math.round(
      Math.min(MAX_IMAGE_WIDTH_PERCENT, Math.max(minPercent, (widthPx / drag.containerWidth) * 100))
    );
    setLiveWidth(percent);
  }

  function handlePointerUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (liveWidth !== null) updateAttributes({ width: liveWidth });
    setLiveWidth(null);
    const pos = getPos();
    if (pos !== undefined) editor.commands.setNodeSelection(pos);
  }

  function openCrop(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const mediaId = node.attrs['data-media-id'] as string | null;
    if (!mediaId) return;
    const cropX = node.attrs.cropX as number | null;
    const cropY = node.attrs.cropY as number | null;
    const cropWidth = node.attrs.cropWidth as number | null;
    const cropHeight = node.attrs.cropHeight as number | null;
    const crop = cropX != null && cropY != null && cropWidth != null && cropHeight != null
      ? { x: cropX, y: cropY, w: cropWidth, h: cropHeight }
      : null;
    editor.storage.image.openEditor?.(mediaId, (node.attrs.alt as string | null) ?? '', crop);
  }

  // A tap on the image body opens a full-screen preview, but only when the
  // image was *already* selected before this tap — not on the first tap that
  // selects it. ProseMirror resolves the NodeSelection synchronously on
  // mousedown/pointerdown (re-rendering with selected=true) before the click
  // event fires, so gating on `selected` alone would open the preview on
  // the very first tap. Instead, wasSelectedOnPointerDownRef captures the
  // pre-tap selected state, and openPreview checks that.
  function handleImgPointerDown() {
    wasSelectedOnPointerDownRef.current = selected;
  }

  function openPreview(e: React.MouseEvent) {
    if (!wasSelectedOnPointerDownRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const mediaId = node.attrs['data-media-id'] as string | null;
    if (!mediaId) return;
    const crop = hasCrop ? { x: cropX!, y: cropY!, w: cropWidth!, h: cropHeight! } : null;
    editor.storage.image.openPreview?.(mediaId, (node.attrs.alt as string | null) ?? '', crop);
  }

  // Deletes straight from here rather than from inside ImageCropModal (an
  // earlier version put it there) — this node is already the current
  // NodeSelection whenever this button is visible at all (it's gated on
  // `selected`, same as the crop button/resize handle), so deleteSelection
  // needs nothing else to know which node to remove.
  function deleteImage(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    editor.chain().focus().deleteSelection().run();
  }

  return (
    <NodeViewWrapper
      as="span"
      // ring-* is a box-shadow, not a border — it doesn't add to the
      // wrapper's own box, so it can't throw off the width/position math
      // above, unlike a real border would.
      className={`relative inline-block ${selected ? 'rounded-sm ring-2 ring-orange-400' : ''}`}
      style={width ? { width: `${width}%` } : undefined}
    >
      {hasCrop ? (
        // Non-destructive crop: the full original image is always what's
        // actually loaded (src/data-media-id never point at a separately
        // cropped file — see MediaImage's own cropX/Y/Width/Height doc
        // comment in lib/tiptapExtensions.ts for why) — this wrapper just
        // clips down to and scales up the cropped rectangle, purely
        // visually. Standard non-destructive-crop CSS technique: the
        // wrapper's aspect-ratio is the crop rect's own pixel dimensions
        // (cropWidth/cropHeight are fractions of the *original*, so
        // multiplying by its natural size gives the real proportions —
        // using the plain fraction ratio as a fallback for the brief
        // moment before naturalSize is known self-corrects once the image
        // actually loads), and the img inside is scaled up by 1/cropWidth
        // (so that fraction of it exactly fills the wrapper) and shifted
        // by -(cropX/cropWidth) / -(cropY/cropHeight) so the crop's own
        // top-left lands on the wrapper's own top-left instead of the
        // original image's.
        <span
          className="relative block overflow-hidden"
          style={{
            width: '100%',
            aspectRatio: naturalSize
              ? `${cropWidth! * naturalSize.w} / ${cropHeight! * naturalSize.h}`
              : `${cropWidth} / ${cropHeight}`,
          }}
        >
          <img
            ref={imgRef}
            src={node.attrs.src}
            alt={(node.attrs.alt as string | null) ?? ''}
            data-media-id={node.attrs['data-media-id']}
            onLoad={handleImgLoad}
            onPointerDown={handleImgPointerDown}
            onClick={openPreview}
            style={{
              position: 'absolute',
              width: `${100 / cropWidth!}%`,
              height: 'auto',
              left: `${-(cropX! / cropWidth!) * 100}%`,
              top: `${-(cropY! / cropHeight!) * 100}%`,
              // Overrides globals.css's `.rich-text-content img { max-width:
              // 100% }` — correct for a plain image, but this one is
              // deliberately rendered oversized (100/cropWidth% of the
              // wrapper, easily past 100%) so that only the cropped slice
              // shows through; capping it at 100% would shrink it back
              // down and defeat the whole crop.
              maxWidth: 'none',
              // zoom-in, not default — see openPreview's own doc comment;
              // once selected a tap opens a full-screen preview now, so the
              // cursor should say so rather than imply nothing happens.
              cursor: selected ? 'zoom-in' : undefined,
            }}
            draggable={false}
          />
        </span>
      ) : (
        <img
          ref={imgRef}
          src={node.attrs.src}
          alt={(node.attrs.alt as string | null) ?? ''}
          data-media-id={node.attrs['data-media-id']}
          onLoad={handleImgLoad}
          onPointerDown={handleImgPointerDown}
          onClick={openPreview}
          // globals.css sets `.rich-text-content img { cursor: pointer }` —
          // accurate for an unselected image (a tap selects it); once
          // selected a tap now opens a full-screen preview (openPreview
          // above) rather than doing nothing, so zoom-in communicates that
          // instead of the plain pointer cursor. An inline style beats that
          // stylesheet rule without needing a more specific selector;
          // omitted (not just `undefined` cursor) when unselected so the
          // CSS rule applies normally.
          style={{ ...(width ? { width: '100%' } : {}), ...(selected ? { cursor: 'zoom-in' } : {}) }}
          draggable={false}
        />
      )}
      {selected && (
        <>
          {/* Same size-6 as ImageCropModal's own corner handles
              (components/MediaShared.tsx) — deliberately matched rather
              than sized up for touch, on request. One control per corner:
              crop top-left, delete top-right, resize bottom-right. */}
          <button
            type="button"
            contentEditable={false}
            onClick={openCrop}
            aria-label="Crop image"
            title="Crop image"
            className="absolute -top-3 -left-3 flex size-6 items-center justify-center rounded-full border-2 border-orange-400 bg-neutral-950 text-orange-400"
          >
            <Crop size={12} strokeWidth={3} />
          </button>
          <button
            type="button"
            contentEditable={false}
            onClick={deleteImage}
            aria-label="Delete image"
            title="Delete image"
            className="absolute -top-3 -right-3 flex size-6 items-center justify-center rounded-full border-2 border-red-400 bg-neutral-950 text-red-400"
          >
            <Trash2 size={12} strokeWidth={3} />
          </button>
          <span
            data-resize-handle="true"
            contentEditable={false}
            onPointerDown={startResize}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{ touchAction: "none" }}
            className="absolute -bottom-3 -right-3 size-6 cursor-nwse-resize rounded-full border-2 border-orange-400 bg-neutral-950"
          />
        </>
      )}
    </NodeViewWrapper>
  );
}

const MediaImageWithView = MediaImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});

// A native <audio controls> element's own play/seek UI covers nearly its
// entire box, intercepting clicks before ProseMirror's own click handling
// ever sees them — unlike a plain <img>, which has no such interactive
// chrome, so a tap on it reliably reaches ProseMirror's default click-to-
// select. Rather than a small dedicated handle *beside* the player (an
// earlier version of this), an invisible click-catching overlay sits
// *over* the whole player while unselected — covering exactly the area a
// user would naturally tap, not a separate small icon easy to miss — and
// selecting removes it, so the real native controls become directly
// usable (play/seek/volume) once selected instead of forever unreachable.
// Once selected, a trim button (top-left) opens the edit modal — via
// editor.storage.audio.openEditor, since this component is defined once at
// module scope, shared by every editor instance, so it can't close over a
// *specific* instance's modal-opening function directly; that storage slot
// is the bridge (see MediaAudio's addStorage in lib/tiptapExtensions.ts) —
// and a delete button (top-right) removes the node directly, mirroring
// ImageNodeView's own crop/delete corner buttons exactly.
function AudioNodeView({ node, selected, editor, getPos, updateAttributes }: ReactNodeViewProps) {
  const dragRef = useRef<{ startX: number; startWidthPx: number; containerWidth: number } | null>(null);
  // Same live-preview-during-drag/commit-once-on-release split as
  // ImageNodeView's own liveWidth, and for the identical reason: a
  // transaction (updateAttributes) mid-gesture can remount this NodeView,
  // silently dropping pointer capture after the first move.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  // Unlike an image, audio has no "natural size" to fall back to — null
  // always means 100% here (see MIN/MAX_AUDIO_WIDTH_PERCENT's own doc
  // comment in lib/richTextModel.ts) — so, unlike ImageNodeView, this is
  // never left unset.
  const width = liveWidth ?? (node.attrs.width as number | null) ?? MAX_AUDIO_WIDTH_PERCENT;

  const trimStart = node.attrs.trimStart as number | null;
  const trimEnd = node.attrs.trimEnd as number | null;
  const src = node.attrs.src as string | null;
  const [trimmedPreviewSrc, setTrimmedPreviewSrc] = useState<string | null>(null);

  // Trim is pure metadata now (see MediaAudio's own doc comment in
  // lib/tiptapExtensions.ts) — the underlying file, whether still a local
  // blob: preview or already uploaded to /api/media/, is always the full
  // original, on purpose, so it's never lost. That means this always has
  // to derive its own short local preview to actually show/play just the
  // trimmed range, regardless of upload state — without this, the inline
  // player would show/play the *entire* original clip, ignoring
  // trimStart/trimEnd entirely (confirmed as the actual bug: the edit
  // modal correctly showed/played just the trimmed range, but the field's
  // own inline player didn't respect it in any way). See
  // lib/trimAudioPreview.ts's own doc comment for why this is a real
  // (if narrow) re-encode rather than a free CSS/attribute fix — Media
  // Fragments URI, the zero-code way to do exactly this, doesn't work for
  // blob: sources in Chromium (confirmed empirically: `audio.duration`
  // still reported the full original length with a #t=start,end suffix).
  useEffect(() => {
    if (trimStart == null || trimEnd == null || !src) {
      setTrimmedPreviewSrc(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const original = await (await fetch(src)).blob();
        const trimmed = await trimAudioBlobForPreview(original, trimStart, trimEnd);
        if (cancelled) return;
        url = URL.createObjectURL(trimmed);
        setTrimmedPreviewSrc(url);
      } catch {
        // Decoding failed (e.g. a format decodeAudioData doesn't support) —
        // fall back to the untrimmed preview rather than showing nothing;
        // this is a local cosmetic-only best effort, nothing else depends
        // on it succeeding.
        if (!cancelled) setTrimmedPreviewSrc(null);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [trimStart, trimEnd, src]);

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = (e.currentTarget as HTMLElement).parentElement;
    if (!wrap) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startWidthPx: wrap.getBoundingClientRect().width,
      containerWidth: contentBoxWidth(editor.view.dom),
    };
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const widthPx = drag.startWidthPx + (e.clientX - drag.startX);
    const percent = Math.round(
      Math.min(MAX_AUDIO_WIDTH_PERCENT, Math.max(MIN_AUDIO_WIDTH_PERCENT, (widthPx / drag.containerWidth) * 100))
    );
    setLiveWidth(percent);
  }

  function handlePointerUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (liveWidth !== null) updateAttributes({ width: liveWidth });
    setLiveWidth(null);
    const pos = getPos();
    if (pos !== undefined) editor.commands.setNodeSelection(pos);
  }

  function openTrim(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const mediaId = node.attrs['data-media-id'] as string | null;
    if (mediaId)
      editor.storage.audio.openEditor?.(
        mediaId,
        (node.attrs.title as string | null) ?? '',
        node.attrs.trimStart as number | null,
        node.attrs.trimEnd as number | null
      );
  }

  // Same reasoning as ImageNodeView's own deleteImage: this node is already
  // the current NodeSelection whenever this button is visible at all (it's
  // gated on `selected`, same as the trim button/resize handle), so
  // deleteSelection needs nothing else to know which node to remove.
  function deleteAudio(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    editor.chain().focus().deleteSelection().run();
  }

  return (
    // inline-flex, not flex — an earlier version used flex specifically to
    // give this wrapper a "real" (non-shrink-to-fit) width for the audio
    // element's own `width: 100%` (globals.css) to resolve against, but
    // flex's outside display is block-level: it forces a line break before
    // and after itself, same as a <div> would, so the caret could never
    // land immediately to either side of it and it visually ate the whole
    // line regardless of how narrow its own width was set — exactly
    // ImageNodeView's `inline-block` wrapper doesn't have this problem, and
    // audio shouldn't either, since MediaAudio is declared `inline: true`
    // the same as MediaImage. inline-flex fixes that (inline outside
    // display, so it sits in the text flow like the image wrapper does)
    // without reintroducing the shrink-to-fit issue the old comment
    // described — that concern was about resolving a *child's* percentage
    // width against this box, which depends only on the box having an
    // explicit `width` set (which the style prop below already does,
    // regardless of flex vs inline-flex — shrink-to-fit is merely the
    // *default* absent an explicit width, not something inline-flex forces)
    // — confirmed via Playwright: the audio element still gets a real
    // resolved (non-zero) width with inline-flex, and the caret can now be
    // placed on either side of the node.
    // ring-*, not a literal border, once selected — same as ImageNodeView's
    // own selection ring (see its doc comment): a box-shadow doesn't add to
    // this wrapper's own box, so it can't throw off the width math above or
    // the resize drag's own getBoundingClientRect() reads, unlike a real
    // border would.
    <NodeViewWrapper
      as="span"
      className={`relative inline-flex items-center ${selected ? 'rounded-sm ring-2 ring-orange-400' : ''}`}
      style={{ width: `${width}%` }}
    >
      <span className="relative w-full">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- editor preview only; the real accessibility label (title) is edited via the edit-audio modal */}
        <audio src={trimmedPreviewSrc ?? node.attrs.src} controls />
        {!selected && (
          <span
            contentEditable={false}
            role="button"
            aria-label="Select audio"
            onClick={() => {
              const pos = getPos();
              if (pos !== undefined) editor.commands.setNodeSelection(pos);
            }}
            className="absolute inset-0 cursor-pointer"
          />
        )}
      </span>
      {selected && (
        <>
          {/* Same size-6 corner-button convention as ImageNodeView's own
              crop/delete/resize trio: trim top-left, delete top-right,
              resize bottom-right. */}
          <button
            type="button"
            contentEditable={false}
            onClick={openTrim}
            aria-label="Trim audio"
            title="Trim audio"
            className="absolute -top-3 -left-3 flex size-6 items-center justify-center rounded-full border-2 border-orange-400 bg-neutral-950 text-orange-400"
          >
            <AudioWaveformIcon size={12} strokeWidth={3} />
          </button>
          <button
            type="button"
            contentEditable={false}
            onClick={deleteAudio}
            aria-label="Delete audio"
            title="Delete audio"
            className="absolute -top-3 -right-3 flex size-6 items-center justify-center rounded-full border-2 border-red-400 bg-neutral-950 text-red-400"
          >
            <Trash2 size={12} strokeWidth={3} />
          </button>
          <span
            data-resize-handle="true"
            contentEditable={false}
            onPointerDown={startResize}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="absolute -bottom-3 -right-3 size-6 cursor-nwse-resize rounded-full border-2 border-orange-400 bg-neutral-950"
          />
        </>
      )}
    </NodeViewWrapper>
  );
}

const MediaAudioWithView = MediaAudio.extend({
  addNodeView() {
    return ReactNodeViewRenderer(AudioNodeView);
  },
});

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// A waveform + draggable-edges region, for picking a trim range — the UI
// half of AudioEditModal's trim feature; the actual cut happens server-side
// (see app/api/media/upload/audio/route.ts's ffmpeg call), so nothing here
// decodes/re-encodes audio itself, only visualizes it and reports back
// whatever range the user dragged. Reports through a ref-call
// (onRegionChange), not React state lifted into the parent — a region drag
// fires continuously, and routing that through the parent's own state on
// every tick would re-render the whole modal (including this waveform)
// each time; the parent only actually needs the latest value once, when
// Save is clicked.
function AudioWaveform({
  src,
  initialStart,
  initialEnd,
  onRegionChange,
}: {
  src: string;
  initialStart: number | null;
  initialEnd: number | null;
  onRegionChange: (start: number, end: number, duration: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region | null>(null);
  const [playing, setPlaying] = useState(false);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const regionsPlugin = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container,
      height: 48,
      waveColor: '#525252', // neutral-600
      progressColor: '#fb923c', // orange-400, matches every other selection/handle accent in this file
      cursorColor: '#fb923c',
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      url: src,
      plugins: [regionsPlugin],
    });
    wsRef.current = ws;

    // decode (not ready — this only needs the duration, not full
    // play-readiness) is the first point a length is known, which is what
    // the default (untrimmed) region needs to size itself to.
    ws.on('decode', (duration) => {
      const region = regionsPlugin.addRegion({
        start: initialStart ?? 0,
        end: initialEnd ?? duration,
        color: 'rgba(251, 146, 60, 0.2)', // orange-400 at low opacity
        drag: false,
        resize: true,
        minLength: 0.2,
      });
      regionRef.current = region;
      setRange({ start: region.start, end: region.end });
      onRegionChange(region.start, region.end, duration);
    });
    const reportRegion = (region: Region) => {
      regionRef.current = region;
      setRange({ start: region.start, end: region.end });
      onRegionChange(region.start, region.end, ws.getDuration());
    };
    regionsPlugin.on('region-update', reportRegion);
    regionsPlugin.on('region-updated', reportRegion);
    ws.on('play', () => setPlaying(true));
    ws.on('pause', () => setPlaying(false));
    ws.on('finish', () => setPlaying(false));

    return () => ws.destroy();
    // initialStart/initialEnd are only meaningful for the region created
    // once, right after decode — re-running this whole effect on every
    // parent re-render (which happens on every keystroke in the label
    // input, a sibling field in the same modal) would tear down and
    // rebuild the waveform for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  function togglePlay() {
    const ws = wsRef.current;
    const region = regionRef.current;
    if (!ws) return;
    if (ws.isPlaying()) ws.pause();
    else if (region) void ws.play(region.start, region.end);
    else void ws.play();
  }

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play selection'}
          className="shrink-0 rounded-full border border-neutral-700 p-1.5 text-neutral-300 hover:bg-neutral-800"
        >
          {playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
        <div ref={containerRef} className="min-w-0 flex-1" />
      </div>
      {range && (
        <p className="mt-1 text-xs text-neutral-500">
          {formatTime(range.start)}–{formatTime(range.end)} selected ({formatTime(range.end - range.start)})
        </p>
      )}
    </div>
  );
}

// Audio's counterpart to ImageCropModal — required label, trim range, and a
// delete action, in one modal instead of the small always-visible bottom
// bar this replaced. Module-scoped like AudioNodeView: defining it inside
// TiptapFieldInput would make React treat it as a new component type on
// every render, remounting (and dropping focus from) its input each time.
function AudioEditModal({
  src,
  initialAlt,
  initialTrimStart,
  initialTrimEnd,
  onCancel,
  onSave,
  onDelete,
}: {
  src: string;
  initialAlt: string;
  initialTrimStart: number | null;
  initialTrimEnd: number | null;
  onCancel: () => void;
  onSave: (alt: string, trim: { start: number; end: number } | null) => void;
  // Only meaningful (and only shown) when editing an audio clip already in
  // the field — a not-yet-inserted one (see TiptapFieldInput's
  // pendingAudioBlob) has nothing to delete yet; Cancel already discards it.
  onDelete?: () => void;
}) {
  const [alt, setAlt] = useState(initialAlt);
  // Not React state — see AudioWaveform's own doc comment for why a region
  // drag reports here instead of lifting into a state variable.
  const trimRef = useRef<{ start: number; end: number; duration: number } | null>(null);

  function handleSave() {
    const region = trimRef.current;
    // A region touching neither edge (start ~0, end ~the full duration) is
    // the same as "untrimmed" — sent as null rather than a redundant
    // {0, duration} pair, so a save where the user never touched the
    // waveform doesn't send this audio through a needless re-queue/re-
    // upload/re-transcode round trip for a trim that wouldn't actually
    // change anything.
    const trim =
      region && (region.start > 0.05 || region.end < region.duration - 0.05)
        ? { start: region.start, end: region.end }
        : null;
    onSave(alt.trim(), trim);
  }

  return (
    <div className="fixed inset-0 z-[60] flex cursor-default items-center justify-center bg-black/70 p-4">
      <div className="flex w-full max-w-sm flex-col rounded-lg border border-neutral-800 bg-neutral-950 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">{onDelete ? 'Edit audio' : 'Add audio'}</p>
          <button type="button" onClick={onCancel} aria-label="Close" className="text-neutral-400 hover:text-neutral-200">
            <X size={16} />
          </button>
        </div>
        <AudioWaveform
          src={src}
          initialStart={initialTrimStart}
          initialEnd={initialTrimEnd}
          onRegionChange={(start, end, duration) => {
            trimRef.current = { start, end, duration };
          }}
        />
        <input
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          placeholder="Describe this audio (required)"
          className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!alt.trim()}
            className="flex-1 rounded-md bg-neutral-100 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-50"
          >
            {onDelete ? 'Save' : 'Add audio'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md border border-neutral-700 py-1.5 text-xs text-neutral-300"
          >
            Cancel
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete audio"
              title="Delete audio"
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Textarea for the raw LaTeX source + a live KaTeX preview (throwOnError:
// false — a syntax error renders as KaTeX's own inline red error text
// instead of throwing, so a mid-typing invalid expression never crashes
// this modal) + a Display toggle (its own centered line vs sitting inline
// in a sentence — see MathInline/MathBlock's own doc comment in
// lib/tiptapBlockExtensions.ts for why that's two different node types
// rather than one attribute). trust is deliberately left at its default
// (false) — KaTeX disables \href/\includegraphics and similar unless a
// caller explicitly opts in via `trust: true`, which this never does, so
// arbitrary LaTeX source can't become an XSS/URL-injection vector.
function MathEditModal({
  initialLatex,
  initialDisplay,
  onCancel,
  onSave,
  onDelete,
}: {
  initialLatex: string;
  initialDisplay: boolean;
  onCancel: () => void;
  onSave: (latex: string, display: boolean) => void;
  // Only meaningful (and only shown) when editing a node already in the
  // field — a not-yet-inserted one has nothing to delete yet; Cancel
  // already discards it. Mirrors AudioEditModal's own onDelete convention.
  onDelete?: () => void;
}) {
  const [latex, setLatex] = useState(initialLatex);
  const [display, setDisplay] = useState(initialDisplay);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!previewRef.current) return;
    if (!latex.trim()) {
      previewRef.current.textContent = '';
      return;
    }
    katex.render(latex, previewRef.current, { throwOnError: false, displayMode: display, output: 'html' });
  }, [latex, display]);

  return (
    <div className="fixed inset-0 z-[60] flex cursor-default items-center justify-center bg-black/70 p-4">
      <div className="flex w-full max-w-sm flex-col rounded-lg border border-neutral-800 bg-neutral-950 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">{onDelete ? 'Edit equation' : 'Insert equation'}</p>
          <button type="button" onClick={onCancel} aria-label="Close" className="text-neutral-400 hover:text-neutral-200">
            <X size={16} />
          </button>
        </div>
        <textarea
          value={latex}
          onChange={(e) => setLatex(e.target.value)}
          placeholder="LaTeX source, e.g. x^2 + y^2 = r^2"
          rows={3}
          autoFocus
          className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm"
        />
        <div
          ref={previewRef}
          className="mt-2 min-h-[2.5rem] overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm text-neutral-100"
        />
        <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
          <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} />
          Display as its own centered line (not inline in a sentence)
        </label>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => onSave(latex.trim(), display)}
            disabled={!latex.trim()}
            className="flex-1 rounded-md bg-neutral-100 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-50"
          >
            {onDelete ? 'Save' : 'Insert'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md border border-neutral-700 py-1.5 text-xs text-neutral-300"
          >
            Cancel
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete equation"
              title="Delete equation"
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Shared by both MathInline and MathBlock's NodeView (see MathBridge's own
// doc comment in lib/tiptapBlockExtensions.ts) — which one this instance is
// backing is read straight off `node.type.name`, the only thing that
// actually differs between them. Renders via katex.render into a ref'd,
// non-editable container — contenteditable="false" on the wrapper (see
// MathInline/MathBlock's own renderHTML) keeps ProseMirror from trying to
// treat KaTeX's internal DOM as editable text.
function MathNodeView({ node, selected, editor, getPos }: ReactNodeViewProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const latex = node.attrs.latex as string;
  const isBlock = node.type.name === 'mathBlock';

  useEffect(() => {
    if (!ref.current) return;
    if (!latex.trim()) {
      ref.current.textContent = '(empty equation)';
      return;
    }
    try {
      katex.render(latex, ref.current, { throwOnError: false, displayMode: isBlock, output: 'html' });
    } catch {
      ref.current.textContent = latex;
    }
  }, [latex, isBlock]);

  function openEditor(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Selected once, up front — the modal is a full covering overlay, so
    // nothing else can change the selection while it's open, meaning
    // onSave/onDelete below can safely rely on this node still being the
    // current NodeSelection whenever they actually run (same reasoning
    // ImageNodeView's own deleteImage/openCrop rely on).
    const pos = getPos();
    if (pos === undefined) return;
    editor.commands.setNodeSelection(pos);
    const onSave = (newLatex: string, newDisplay: boolean) => {
      if (newDisplay === isBlock) {
        // Same node type as before — a plain attribute update, matching
        // every other "editing existing content is just updateAttributes"
        // pattern in this schema.
        editor.chain().focus().updateAttributes(node.type.name, { latex: newLatex }).run();
      } else {
        // Display mode flipped — inline vs block is a different node TYPE
        // here (see MathInline/MathBlock's own doc comment for why), not
        // just an attribute, so this replaces the node outright rather than
        // updating it in place. deleteSelection first (removes the old
        // node, landing the cursor exactly where it was), then insert the
        // new type there.
        editor
          .chain()
          .focus()
          .deleteSelection()
          .insertContent({ type: newDisplay ? 'mathBlock' : 'mathInline', attrs: { latex: newLatex } })
          .run();
      }
    };
    const onDelete = () => {
      editor.chain().focus().deleteSelection().run();
    };
    editor.storage.math.openEditor?.({ latex, display: isBlock }, onSave, onDelete);
  }

  return (
    <NodeViewWrapper
      as={isBlock ? 'div' : 'span'}
      className={`${isBlock ? 'block text-center' : 'inline-block'} cursor-pointer rounded ${
        selected ? 'ring-2 ring-orange-400' : ''
      }`}
      onClick={openEditor}
    >
      <span ref={ref} contentEditable={false} />
    </NodeViewWrapper>
  );
}

const MathInlineWithView = MathInline.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },
});
const MathBlockWithView = MathBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },
});

interface TiptapFieldInputProps {
  value: string; // sanitized HTML
  onChange: (html: string) => void;
  placeholder?: string;
  // Format a brand-new, still-empty field should start typing in (see
  // NoteType.fieldTemplates) — applied once, the first time this field is
  // focused while still empty. Never touches non-empty content.
  initialFormat?: TextFormat;
}

// One entry per table currently in the editor — see the effect that
// computes these (right before TiptapFieldInput's own return statement)
// for why this lives in React state rather than being applied directly to
// the DOM. top/left/width/height are relative to tableFadeAnchorRef's own
// box, not the viewport.
interface TableFadeInfo {
  key: string;
  top: number;
  left: number;
  width: number;
  height: number;
  showLeft: boolean;
  showRight: boolean;
}

// Matches lib/tableFade.ts's own fade width (w-[13px]) — kept the same
// value in both places so the live editor's tables and RichText.tsx's
// read-only ones fade over the identical distance.
const TABLE_FADE_WIDTH = 8;

export function TiptapFieldInput({ value, onChange, placeholder, initialFormat }: TiptapFieldInputProps) {
  // Tiptap's own useEditorState hook wasn't picking up transactions reliably
  // in testing (its snapshot lagged a render behind the editor becoming
  // ready) — bumping a plain counter on every transaction and reading
  // editor.isActive()/getAttributes()/state.selection straight from the
  // editor instance on each render is simpler and more predictable.
  const [, forceRerender] = useReducer((c: number) => c + 1, 0);
  const seededRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  // "More to scroll" hints for the toolbar — see the effect below for why
  // these need to be real overlay elements (ScrollFade.tsx's own
  // technique) rather than the CSS-only background-gradient trick
  // .scroll-fade-x/.tableWrapper use elsewhere in this file: that trick
  // only shows through genuinely transparent/empty background area, which
  // a table (lots of unstyled cell padding) has plenty of but this toolbar
  // (packed edge-to-edge with opaque icon buttons) barely does — confirmed
  // empirically close to invisible here.
  //
  // The left one isn't at the toolbar's own left edge — the sticky
  // Undo/Redo group already opaquely occupies that whole region regardless
  // of scroll position, so a fade *there* would have nothing real to fade
  // into. It's positioned at leftFadeOffset instead: the sticky group's own
  // rendered width, i.e. exactly the boundary where scrolled-away content
  // actually disappears out of view underneath it — see stickyGroupRef.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const stickyGroupRef = useRef<HTMLDivElement>(null);
  const [showToolbarFadeLeft, setShowToolbarFadeLeft] = useState(false);
  const [showToolbarFadeRight, setShowToolbarFadeRight] = useState(false);
  const [leftFadeOffset, setLeftFadeOffset] = useState(0);
  // Positioning anchor for the editor's own table fade overlays — see the
  // effect below (right before the return statement's fade-computing
  // logic) for why these are plain React elements rendered as siblings of
  // <EditorContent> rather than anything injected into ProseMirror's own
  // DOM, and why their coordinates are relative to *this* anchor rather
  // than the viewport.
  const tableFadeAnchorRef = useRef<HTMLDivElement>(null);
  const [tableFades, setTableFades] = useState<TableFadeInfo[]>([]);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  // The full, unprocessed original file being cropped — only set (and only
  // needed) for a fresh insert, where nothing's been queued yet; null for
  // a recrop, which never needs the bytes at all anymore (just an
  // attribute update on a node that already has its own data-media-id).
  const [cropOriginalBlob, setCropOriginalBlob] = useState<Blob | null>(null);
  const [recropMediaId, setRecropMediaId] = useState<string | null>(null); // set when cropping replaces an existing node instead of inserting a new one
  const [recropAlt, setRecropAlt] = useState(''); // that node's current label, pre-filled into the modal
  const [recropCrop, setRecropCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null); // that node's current crop, pre-filled into the modal
  const [previewSrc, setPreviewSrc] = useState<string | null>(null); // non-null shows ImagePreviewModal — set via editor.storage.image.openPreview
  const [previewAlt, setPreviewAlt] = useState('');
  const [previewCrop, setPreviewCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [audioEditMediaId, setAudioEditMediaId] = useState<string | null>(null);
  const [audioEditAlt, setAudioEditAlt] = useState('');
  const [audioEditSrc, setAudioEditSrc] = useState<string | null>(null);
  const [audioEditTrimStart, setAudioEditTrimStart] = useState<number | null>(null);
  const [audioEditTrimEnd, setAudioEditTrimEnd] = useState<number | null>(null);
  const [pendingAudioBlob, setPendingAudioBlob] = useState<Blob | null>(null); // recorded/picked but not yet inserted — held until a label is given (mirrors ImageCropModal gating an image insert on its alt)
  const [pendingAudioSrc, setPendingAudioSrc] = useState<string | null>(null); // live preview for pendingAudioBlob's waveform, derived below
  const [mediaError, setMediaError] = useState('');
  // Non-null shows MathEditModal. mathEditing holds the onSave/onDelete
  // closures MathNodeView built from its own node — see MathBridge's own
  // doc comment in lib/tiptapBlockExtensions.ts for why those are closures
  // rather than a raw document position. null onSave/onDelete (rather than
  // a whole separate "inserting" boolean) means "insert a new one" — same
  // "shape of the state IS the mode" convention as recropMediaId elsewhere
  // in this component.
  const [mathEditing, setMathEditing] = useState<{
    latex: string;
    display: boolean;
    onSave: ((latex: string, display: boolean) => void) | null;
    onDelete: (() => void) | null;
  } | null>(null);

  const editor = useEditor({
    extensions: [
      BlockDoc,
      BlockEssentials,
      Paragraph,
      BlockAlign,
      Blockquote,
      BulletList,
      OrderedList,
      ListItem,
      ListKeymap,
      HorizontalRule,
      CodeBlock,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      Text,
      HardBreak,
      History,
      BoldMark,
      ItalicMark,
      UnderlineMark,
      DimMark,
      FontSize,
      TextColor,
      MediaImageWithView,
      MediaAudioWithView,
      MathInlineWithView,
      MathBlockWithView,
      MathBridgeExtension,
    ],
    // sanitizeRichText, not raw `value` — closes the one gap in the "an
    // uploaded id's src is never trusted, always regenerated from
    // data-media-id" rule (see MediaImage's doc comment in
    // lib/tiptapExtensions.ts): that rule is otherwise only actually
    // enforced at save time (onUpdate below) and at read-only render time
    // (RichText.tsx sanitizes on every render). Content that arrives here
    // never having been through sanitizeRichText even once — e.g. a JSON
    // import, which writes front/back straight from the file — stores a
    // bare `data-media-id` with no `src` at all, so without this the
    // editor would parse `src` as null and show a broken image despite the
    // media itself being perfectly intact.
    content: sanitizeRichText(value),
    immediatelyRender: false, // avoids an SSR/hydration mismatch in Next.js
    onUpdate: ({ editor }) => onChange(sanitizeRichText(editor.getHTML())),
    onTransaction: () => forceRerender(),
    onFocus: ({ editor }) => {
      // Once, the first time this field is focused while still empty — sets
      // *stored* marks (ProseMirror's "what the next typed character
      // inherits" state at a collapsed cursor), the same mechanism every
      // toolbar toggle already uses on a collapsed selection, so this is
      // just calling those same commands rather than a separate mechanism.
      if (!initialFormat || seededRef.current || !editor.isEmpty) return;
      seededRef.current = true;
      const chain = editor.chain().focus();
      if (initialFormat.bold) chain.setMark('bold');
      if (initialFormat.italic) chain.setMark('italic');
      if (initialFormat.underline) chain.setMark('underline');
      if (initialFormat.dim) chain.setMark('dim');
      if (initialFormat.size !== NORMAL_SIZE) chain.setMark('fontSize', { size: String(initialFormat.size) });
      if (initialFormat.color) chain.setMark('textColor', { color: initialFormat.color });
      chain.run();
    },
    editorProps: {
      attributes: {
        class: 'rich-text-content min-h-[2.5rem] rounded-b-md px-3 py-2 text-sm outline-none',
      },
      // Explicitly selects the image on a tap, rather than trusting
      // ProseMirror's own default click-to-select (its usual fallback for
      // any node it doesn't get a handler result for) — confirmed
      // empirically that the default is NOT reliable here: posAtCoords
      // correctly finds the image and it passes every one of
      // NodeSelection's own isSelectable/isAtom checks, yet a plain click
      // still ends up producing a nearby TextSelection instead of
      // selecting the node. (ProseMirror's own click handling has known
      // special-casing for this — ImageNodeView's doc comment on
      // `draggable: false` in lib/tiptapExtensions.ts has the detail —
      // and disabling that alone wasn't sufficient to fix it either.)
      // Same proven fix as AudioNodeView already relies on for its own
      // click-driven selection: dispatch a NodeSelection directly, and
      // return true so ProseMirror's own (unreliable) fallback never runs
      // at all. ImageNodeView's crop button/resize handle both
      // stopPropagation their own pointer events, so this never fires for
      // clicks that originate there.
      handleClickOn: (view, _pos, node, nodePos) => {
        if (node.type.name !== 'image') return false;
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
        return true;
      },
    },
  });

  // Sync external value changes (switching cards/fields) without fighting
  // the user's own typing — only push when the incoming value differs from
  // what the editor currently holds, i.e. this wasn't just the echo of our
  // own last onUpdate coming back around through the parent. Compared
  // through sanitizeRichText rather than raw editor.getHTML(): an inline
  // image/audio node's `src` is never trusted as-is (see MediaImage's doc
  // comment in lib/tiptapExtensions.ts), so the live editor's DOM can
  // legitimately have a src (a blob: URL for live preview) that the
  // sanitized value never carries — comparing raw HTML would treat that as
  // an external change on every keystroke and fight the live preview.
  useEffect(() => {
    if (!editor) return;
    // Both sides sanitized (see the matching comment on `content` above) —
    // comparing a raw, never-sanitized `value` (e.g. straight off an
    // import) against sanitized editor HTML would always read as "changed"
    // and, worse, would reset the editor back to the un-backfilled raw
    // HTML, undoing the src backfill on every render this effect re-runs.
    const sanitizedValue = sanitizeRichText(value);
    if (sanitizedValue !== sanitizeRichText(editor.getHTML())) {
      editor.commands.setContent(sanitizedValue, { emitUpdate: false });
    }
  }, [value, editor]);

  // Fills in a live blob: URL for any pending (not-yet-uploaded) image/
  // audio node that doesn't already have a src — the exact same utility
  // RichText's read-only display already uses (see lib/mediaRehydrate.ts),
  // applied to the editor's own rendered DOM instead. Only needed for
  // content that arrived via `value` (a draft saved while still offline);
  // insertImage/insertAudio below set a live src themselves at insert time.
  useEffect(() => {
    if (!editor) return;
    return rehydratePendingMedia(editor.view.dom);
  }, [editor, value]);

  // Real overlay fade for the editor's own tables too (not just
  // .tableWrapper's own CSS-only background-gradient fallback — see
  // globals.css's doc comment on why that alone isn't visible enough), but
  // NOT via lib/tableFade.ts's approach (wrapping .tableWrapper itself) —
  // that WRITES into ProseMirror-managed DOM from outside its own
  // transaction system, which PM's own internal MutationObserver detects
  // and "repairs," retriggering whatever installed it — confirmed, this
  // isn't theoretical, an earlier version of this effect did exactly that
  // and produced a real infinite loop (pegged a CPU core in testing).
  //
  // This version only ever *reads* from editor.view.dom (getBoundingClientRect,
  // scrollLeft, addEventListener/ResizeObserver — none of these mutate the
  // DOM or trigger PM's own observer) and renders the fade overlays as
  // ordinary React elements entirely *outside* it — siblings of
  // <EditorContent>, absolutely positioned using coordinates computed
  // relative to editorContentAnchorRef below. Position, not viewport-fixed
  // coordinates: the anchor and every table inside editor.view.dom scroll
  // together as one unit in normal page flow, so their relative offset
  // stays correct without needing to separately track page/modal scroll —
  // only genuine size/table-count changes need recomputing.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const anchor = tableFadeAnchorRef.current;
    if (!anchor) return;

    const ids = new WeakMap<Element, string>();
    let nextId = 0;
    const observedWrappers = new Set<Element>();
    const ro = new ResizeObserver(compute);

    function compute() {
      const wrappers = Array.from(dom.querySelectorAll<HTMLElement>('.tableWrapper'));
      const current = new Set<Element>(wrappers);
      observedWrappers.forEach((w) => {
        if (!current.has(w)) {
          ro.unobserve(w);
          observedWrappers.delete(w);
        }
      });
      wrappers.forEach((w) => {
        if (!observedWrappers.has(w)) {
          ro.observe(w);
          observedWrappers.add(w);
        }
      });
      const anchorRect = anchor!.getBoundingClientRect();
      setTableFades(
        wrappers.map((w) => {
          if (!ids.has(w)) ids.set(w, `t${nextId++}`);
          const r = w.getBoundingClientRect();
          return {
            key: ids.get(w)!,
            top: r.top - anchorRect.top,
            left: r.left - anchorRect.left,
            width: r.width,
            height: r.height,
            showLeft: w.scrollLeft > 1,
            showRight: w.scrollLeft + w.clientWidth < w.scrollWidth - 1,
          };
        })
      );
    }

    compute();
    // capture: true — scroll doesn't bubble, so this is what catches a
    // .tableWrapper (a descendant) scrolling horizontally.
    dom.addEventListener('scroll', compute, true);
    ro.observe(anchor);
    const mo = new MutationObserver(compute);
    mo.observe(dom, { childList: true, subtree: true });
    window.addEventListener('resize', compute);

    return () => {
      dom.removeEventListener('scroll', compute, true);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', compute);
      setTableFades([]);
    };
  }, [editor]);

  // Drives showToolbarFadeLeft/Right and leftFadeOffset (see their own doc
  // comment above). Unlike ScrollFade.tsx's own single-wrapping-content-
  // child case, this row's scrollable content is however many of its
  // *many direct children* (individual buttons) happen to be present — the
  // code-language <select> and table's contextual row/column controls only
  // render conditionally, changing the row's scrollWidth with no single
  // child whose own resize a ResizeObserver could watch. A
  // MutationObserver on childList catches exactly that (a button mounting/
  // unmounting) that a ResizeObserver can't; the ResizeObserver on the row
  // itself still covers the other case (the field's own width changing,
  // e.g. on rotation/resize) — also observing stickyGroupRef, since its
  // own width (Undo+Redo+divider) is what leftFadeOffset tracks.
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const update = () => {
      setShowToolbarFadeLeft(el.scrollLeft > 1);
      setShowToolbarFadeRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
      if (stickyGroupRef.current) setLeftFadeOffset(stickyGroupRef.current.getBoundingClientRect().width);
    };
    update();
    el.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (stickyGroupRef.current) ro.observe(stickyGroupRef.current);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
    };
    // editor, not []: this component returns null until the editor is
    // ready (see the guard below), so toolbarRef.current is still null the
    // first time this runs — it has to re-run once editor becomes truthy
    // and the toolbar itself actually mounts, matching every other effect
    // in this component that depends on the editor's own readiness.
  }, [editor]);

  // Must run unconditionally, before the `if (!editor) return null` guard
  // below. Recording (or picking a file, see handleAudioFileChange) only
  // stages the blob — it doesn't insert anything yet, matching how
  // ImageCropModal gates an image's insertion on its alt text; see
  // pendingAudioBlob's render below for where the label actually gets
  // collected and the node actually gets created.
  const {
    recording,
    error: recordError,
    start: startRecording,
    stop: stopRecording,
    saveBlob: saveRecordedBlob,
  } = useAudioRecorder(setPendingAudioBlob, MAX_AUDIO_BYTES);

  // Also unconditional, same reasoning as above — derives the live preview
  // src AudioWaveform needs from pendingAudioBlob, revoking the previous
  // one whenever the blob changes (a fresh recording/pick replacing an
  // earlier still-unlabeled one) or the field unmounts.
  useEffect(() => {
    if (!pendingAudioBlob) {
      setPendingAudioSrc(null);
      return;
    }
    const url = URL.createObjectURL(pendingAudioBlob);
    setPendingAudioSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingAudioBlob]);

  if (!editor) return null;

  // Bridge for ImageNodeView/AudioNodeView (each defined once at module
  // scope, shared by every editor instance) to reach back into this
  // specific instance's modal state — see MediaImage/MediaAudio's
  // addStorage in lib/tiptapExtensions.ts. Reassigned every render; cheap,
  // and always needs the latest setState/openRecrop closures anyway.
  editor.storage.image.openEditor = (mediaId, alt, crop) => {
    void openRecrop(mediaId, alt, crop);
  };
  editor.storage.image.openPreview = (mediaId, alt, crop) => {
    void openImagePreview(mediaId, alt, crop);
  };
  editor.storage.audio.openEditor = (mediaId, alt, trimStart, trimEnd) => {
    void openAudioEdit(mediaId, alt, trimStart, trimEnd);
  };
  editor.storage.math.openEditor = (current, onSave, onDelete) => {
    setMathEditing({ latex: current.latex, display: current.display, onSave, onDelete });
  };

  const state = {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    dim: editor.isActive('dim'),
    color: editor.getAttributes('textColor').color as string | undefined,
    isEmpty: editor.isEmpty,
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    blockquote: editor.isActive('blockquote'),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    // Reads from whichever of paragraph/blockquote is actually active —
    // same "check the node currently at the selection" idea as every other
    // getAttributes() read here, just picking the right node type first
    // since align isn't its own mark the way bold/italic/color are.
    align: (editor.isActive('blockquote') ? editor.getAttributes('blockquote') : editor.getAttributes('paragraph'))
      .align as AlignValue | undefined,
    codeBlock: editor.isActive('codeBlock'),
    codeBlockLanguage: editor.getAttributes('codeBlock').language as string | null | undefined,
    table: editor.isActive('table'),
  };

  function stepSize(delta: number) {
    const current = editor!.getAttributes('fontSize').size as string | undefined;
    const currentNum = current ? parseInt(current, 10) : NORMAL_SIZE;
    const next = Math.min(MAX_SIZE, Math.max(MIN_SIZE, currentNum + delta));
    if (next === currentNum) return;
    if (next === NORMAL_SIZE) {
      editor!.chain().focus().unsetMark('fontSize').run();
    } else {
      editor!.chain().focus().setMark('fontSize', { size: String(next) }).run();
    }
  }

  function setColor(color: string | null) {
    if (color) editor!.chain().focus().setMark('textColor', { color }).run();
    else editor!.chain().focus().unsetMark('textColor').run();
  }

  // No sensible "typing state" equivalent for a text transform — there's no
  // future text yet to transform, so this is a no-op on a collapsed
  // selection, matching bold/italic's own native behavior of needing an
  // actual selection to act on.
  //
  // Rewrites in place rather than via a plain toggleMark-style command
  // because the transform has to preserve each text run's own marks (bold,
  // color, etc.) individually — the selection can span several differently-
  // formatted runs, and a single bulk replace would only be able to apply
  // one mark set to the whole result, silently flattening the others.
  function applyTextTransform(fn: (s: string) => string) {
    const { state } = editor!;
    const { from, to } = state.selection;
    if (from === to) return;
    const segments: { from: number; to: number; text: string; marks: readonly Mark[] }[] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return;
      const segFrom = Math.max(from, pos);
      const segTo = Math.min(to, pos + node.nodeSize);
      if (segFrom >= segTo) return;
      segments.push({
        from: segFrom,
        to: segTo,
        text: fn(state.doc.textBetween(segFrom, segTo)),
        marks: node.marks,
      });
    });
    const tr = state.tr;
    // Applied back-to-front so replacing an earlier segment doesn't shift
    // the still-pending positions of the ones after it.
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      tr.replaceWith(seg.from, seg.to, state.schema.text(seg.text, seg.marks));
    }
    editor!.view.dispatch(tr);
    editor!.commands.focus();
  }

  function insertImage(blob: Blob, alt: string, crop: { x: number; y: number; w: number; h: number } | null) {
    void (async () => {
      const markerId = await queueMediaId('image', blob);
      const src = URL.createObjectURL(blob);
      const pos = editor!.state.selection.from;
      editor!
        .chain()
        .focus()
        .insertContent({
          type: 'image',
          attrs: {
            'data-media-id': markerId,
            src,
            alt,
            cropX: crop?.x ?? null,
            cropY: crop?.y ?? null,
            cropWidth: crop?.w ?? null,
            cropHeight: crop?.h ?? null,
          },
        })
        .run();
      // Select what was just inserted (rather than leaving the cursor after
      // it) — lets Backspace/Delete remove it immediately without needing
      // to click it first, and matches insertAudio's own selection below
      // (needed there so its edit modal — opened via a click, see
      // AudioNodeView — knows which node updateAttributes/deleteSelection
      // should target).
      editor!.chain().setNodeSelection(pos).run();
    })();
  }

  function insertAudio(blob: Blob, alt: string, trim: { start: number; end: number } | null) {
    void (async () => {
      const markerId = await queueMediaId('audio', blob);
      const src = URL.createObjectURL(blob);
      const pos = editor!.state.selection.from;
      editor!
        .chain()
        .focus()
        .insertContent({
          type: 'audio',
          attrs: {
            'data-media-id': markerId,
            src,
            title: alt,
            trimStart: trim?.start ?? null,
            trimEnd: trim?.end ?? null,
          },
        })
        .run();
      editor!.chain().setNodeSelection(pos).run();
    })();
  }

  function closeAudioEditModal() {
    // A same-origin /api/media/ path (an already-uploaded clip), not a
    // blob: URL, makes this a harmless no-op — same as closeCropModal's
    // identical revoke-unconditionally call for cropSrc.
    if (audioEditSrc) URL.revokeObjectURL(audioEditSrc);
    setAudioEditMediaId(null);
    setAudioEditAlt('');
    setAudioEditTrimStart(null);
    setAudioEditTrimEnd(null);
    setAudioEditSrc(null);
  }

  async function openAudioEdit(mediaId: string, alt: string, trimStart: number | null, trimEnd: number | null) {
    const src = await resolveMediaSrcById(mediaId);
    if (!src) return;
    setAudioEditMediaId(mediaId);
    setAudioEditAlt(alt);
    setAudioEditTrimStart(trimStart);
    setAudioEditTrimEnd(trimEnd);
    setAudioEditSrc(src);
  }

  // Trim is pure metadata now — never touches the underlying file, so
  // saving one (whether it's just the label, just the trim range, or
  // both) is always a plain attribute update. No re-queue/re-upload,
  // unlike an earlier version of this that had to re-process the audio
  // itself for any trim change.
  function handleAudioEditSaved(alt: string, trim: { start: number; end: number } | null) {
    const mediaId = audioEditMediaId;
    closeAudioEditModal();
    if (!mediaId) return;
    editor!
      .chain()
      .focus()
      .updateAttributes('audio', { title: alt, trimStart: trim?.start ?? null, trimEnd: trim?.end ?? null })
      .run();
  }

  function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setMediaError('Image is too large (max 8 MB).');
      return;
    }
    setMediaError('');
    setRecropMediaId(null); // fresh insert, not replacing an existing node
    setRecropAlt('');
    setRecropCrop(null);
    setCropOriginalBlob(file);
    setCropSrc(URL.createObjectURL(file));
  }

  function closeCropModal() {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
    setCropOriginalBlob(null);
    setRecropMediaId(null);
    setRecropAlt('');
    setRecropCrop(null);
  }

  // Cropping is pure metadata now — never touches the underlying file, so
  // a recrop is always just an attribute update (data-media-id/src never
  // change), the same simplification trim got for audio. A fresh insert
  // still needs to actually queue the original file, since nothing's been
  // uploaded yet at all.
  function handleCropped(crop: { x: number; y: number; w: number; h: number } | null, alt: string) {
    const recropping = recropMediaId;
    const originalBlob = cropOriginalBlob;
    closeCropModal();
    if (recropping) {
      editor!
        .chain()
        .focus()
        .updateAttributes('image', {
          alt,
          cropX: crop?.x ?? null,
          cropY: crop?.y ?? null,
          cropWidth: crop?.w ?? null,
          cropHeight: crop?.h ?? null,
        })
        .run();
    } else if (originalBlob) {
      insertImage(originalBlob, alt, crop);
    }
  }

  async function openRecrop(
    mediaId: string,
    currentAlt: string,
    currentCrop: { x: number; y: number; w: number; h: number } | null
  ) {
    const src = await resolveMediaSrcById(mediaId);
    if (!src) return;
    setRecropMediaId(mediaId);
    setRecropAlt(currentAlt);
    setRecropCrop(currentCrop);
    setCropSrc(src);
  }

  // Same src resolution as openRecrop above (a still-pending upload's src
  // is a local blob: URL looked up by marker id, an already-uploaded one is
  // a plain /api/media/ path) — driving ImagePreviewModal instead of
  // ImageCropModal.
  async function openImagePreview(
    mediaId: string,
    alt: string,
    crop: { x: number; y: number; w: number; h: number } | null
  ) {
    const src = await resolveMediaSrcById(mediaId);
    if (!src) return;
    setPreviewAlt(alt);
    setPreviewCrop(crop);
    setPreviewSrc(src);
  }

  function closeImagePreview() {
    setPreviewSrc(null);
  }

  function handleAudioFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) saveRecordedBlob(file);
  }

  return (
    <div className="rounded-md border border-neutral-700 bg-neutral-900">
      {/* overscroll-none, not just overscroll-contain — contain only stops
          a maxed-out scroll from *chaining* to the page (the ancestor still
          doesn't move), but leaves this element's own default overscroll
          effect alone, which on a touch device (this app's primary use is
          an iOS PWA) is a visible elastic/rubber-band bounce past the last
          item — blank space revealed beyond the real content before it
          springs back. `none` disables that too, not just the chaining, so
          pulling past either end just stops right at the last real button
          instead of bouncing into empty space. Both axes, not just x, for
          the same "a diagonal gesture shouldn't leak its y component
          either" reasoning as the toolbar has no vertical scroll to
          bounce on anyway, but this keeps it explicit rather than assuming. */}
      {/* py-1 pr-1, NOT p-1 — no *leading* padding on the scroll container
          itself, on purpose (see the sticky group's own comment below for
          why). The outer `relative` wrapper anchors the fade overlays
          below it — siblings of the scroll row, not descendants, so they
          stay visually pinned instead of scrolling away with the row's own
          content (the same reason ScrollFade.tsx's own fade divs are
          siblings of its scroller, not children). */}
      <div className="relative">
        <div
          ref={toolbarRef}
          className="flex flex-nowrap gap-1 overflow-x-auto overscroll-none border-b border-neutral-700 py-1 pr-1 [&>*]:shrink-0"
        >
        {/* Sticky, not just first — Undo/Redo are the two buttons reached
            for constantly, so they shouldn't scroll out of view along with
            the rest of the (now horizontally-scrolling) toolbar. Its own
            solid bg-neutral-900 (matching the toolbar's) is required for a
            sticky element over scrolling siblings, otherwise whatever
            scrolls underneath would show through.
            A first attempt gave the scroll container plain p-1 (padding on
            all sides) and compensated with a negative margin + matching
            offset/padding on this sticky group, relying on a negative
            margin bleeding into the container's own padding to cover it —
            technically verified working in both Chromium and desktop
            WebKit at the time, but a `position: sticky` + negative-margin-
            into-padding interaction is exactly the kind of thing real iOS
            Safari's touch/momentum scrolling has a history of not handling
            the same way desktop testing does, and it came back as still
            visible on-device. This sidesteps the question entirely instead
            of relying on that interaction: pl-1 here is the field's only
            *leading* padding at all (the scroll container itself has none,
            see above) — since there's no container padding for the sticky
            offset calculation to be inconsistent about, plain left-0 is
            enough, and this group's own opaque background naturally starts
            exactly at the scroll container's true left edge with nothing
            to cover. */}
        <div ref={stickyGroupRef} className="sticky left-0 z-10 flex shrink-0 gap-1 bg-neutral-900 pl-1">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!state.canUndo}
            aria-label="Undo"
            title="Undo"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!state.canRedo}
            aria-label="Redo"
            title="Redo"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Redo2 size={14} />
          </button>
          <div className="w-px bg-neutral-700" />
        </div>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleMark('bold').run()}
          aria-label="Bold"
          aria-pressed={state.bold}
          className={`rounded p-1 ${
            state.bold
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleMark('italic').run()}
          aria-label="Italic"
          aria-pressed={state.italic}
          className={`rounded p-1 ${
            state.italic
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Italic size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleMark('underline').run()}
          aria-label="Underline"
          aria-pressed={state.underline}
          className={`rounded p-1 ${
            state.underline
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Underline size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleMark('dim').run()}
          aria-label="Dim text"
          aria-pressed={state.dim}
          className={`rounded p-1 ${
            state.dim
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <EyeDashed size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyTextTransform((s) => s.toUpperCase())}
          aria-label="Capitalize"
          title="Capitalize"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <CaseUpper size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyTextTransform((s) => s.toLowerCase())}
          aria-label="Decapitalize"
          title="Decapitalize"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <CaseLower size={14} />
        </button>
        <DropdownMenu
          trigger={({ onClick, open }) => (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClick}
              aria-label="Text color"
              aria-pressed={open || !!state.color}
              className={`rounded p-1 ${
                state.color
                  ? 'bg-neutral-700 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
              }`}
              style={state.color ? { color: COLOR_PALETTE[state.color as keyof typeof COLOR_PALETTE] } : undefined}
            >
              <Baseline size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="grid w-max grid-cols-4 gap-1 p-1">
              {(Object.keys(COLOR_PALETTE) as (keyof typeof COLOR_PALETTE)[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setColor(state.color === key ? null : key);
                    close();
                  }}
                  aria-label={key}
                  aria-pressed={state.color === key}
                  className={`h-6 w-6 rounded-full border ${
                    state.color === key ? 'border-neutral-100' : 'border-neutral-700'
                  }`}
                  style={{ backgroundColor: COLOR_PALETTE[key] }}
                />
              ))}
            </div>
          )}
        </DropdownMenu>
        <div className="w-px bg-neutral-700" />
        <DropdownMenu
          trigger={({ onClick, open }) => (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClick}
              aria-label="Text align"
              aria-pressed={open || !!state.align}
              className={`rounded p-1 ${
                state.align ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
              }`}
            >
              {state.align === 'center' ? (
                <AlignCenter size={14} />
              ) : state.align === 'right' ? (
                <AlignRight size={14} />
              ) : state.align === 'justify' ? (
                <AlignJustify size={14} />
              ) : (
                <AlignLeft size={14} />
              )}
            </button>
          )}
        >
          {(close) => (
            <div className="flex gap-1 p-1">
              {([
                ['left', AlignLeft],
                ['center', AlignCenter],
                ['right', AlignRight],
                ['justify', AlignJustify],
              ] as const).map(([value, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (state.align === value) editor.chain().focus().unsetAlign().run();
                    else editor.chain().focus().setAlign(value).run();
                    close();
                  }}
                  aria-label={`Align ${value}`}
                  aria-pressed={state.align === value}
                  className={`rounded p-1.5 ${
                    state.align === value
                      ? 'bg-neutral-700 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                  }`}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          )}
        </DropdownMenu>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          aria-label="Block quote"
          title="Block quote"
          aria-pressed={state.blockquote}
          className={`rounded p-1 ${
            state.blockquote
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Quote size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          aria-label="Bullet list"
          title="Bullet list"
          aria-pressed={state.bulletList}
          className={`rounded p-1 ${
            state.bulletList
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <List size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          aria-label="Numbered list"
          title="Numbered list"
          aria-pressed={state.orderedList}
          className={`rounded p-1 ${
            state.orderedList
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <ListOrdered size={14} />
        </button>
        <div className="w-px bg-neutral-700" />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          aria-label="Code block"
          title="Code block"
          aria-pressed={state.codeBlock}
          className={`rounded p-1 ${
            state.codeBlock
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          <Code2 size={14} />
        </button>
        {/* Only shown with the cursor actually inside a code block — a
            language picker means nothing anywhere else. */}
        {state.codeBlock && (
          <select
            value={state.codeBlockLanguage ?? 'plaintext'}
            onChange={(e) =>
              editor.chain().focus().updateAttributes('codeBlock', { language: e.target.value }).run()
            }
            aria-label="Code block language"
            className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-300"
          >
            {CODE_BLOCK_LANGUAGES.map(({ key, label }) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          aria-label="Horizontal rule"
          title="Horizontal rule"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          aria-label="Insert table"
          title="Insert table"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <Table2 size={14} />
        </button>
        {/* Contextual — only meaningful with the cursor actually inside a
            table, same "shown only when relevant" convention as the code
            language picker above and ImageNodeView/AudioNodeView's own
            selected-only corner buttons. */}
        {state.table && (
          <>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().addRowAfter().run()}
              aria-label="Add row"
              title="Add row"
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <Rows3 size={14} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().addColumnAfter().run()}
              aria-label="Add column"
              title="Add column"
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <Columns3 size={14} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().deleteRow().run()}
              aria-label="Delete row"
              title="Delete row"
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <Rows3 size={14} className="opacity-60" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().deleteColumn().run()}
              aria-label="Delete column"
              title="Delete column"
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <Columns3 size={14} className="opacity-60" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().deleteTable().run()}
              aria-label="Delete table"
              title="Delete table"
              className="rounded p-1 text-red-400 hover:bg-red-950"
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMathEditing({ latex: '', display: false, onSave: null, onDelete: null })}
          aria-label="Insert equation"
          title="Insert equation"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <Sigma size={14} />
        </button>
        <div className="w-px bg-neutral-700" />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepSize(-1)}
          aria-label="Smaller text"
          title="Smaller text"
          className="rounded px-1.5 text-xs leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepSize(1)}
          aria-label="Bigger text"
          title="Bigger text"
          className="rounded px-1.5 text-lg leading-6 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          A
        </button>
        <div className="w-px bg-neutral-700" />
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageFileChange} />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => imageInputRef.current?.click()}
          aria-label="Insert image"
          title="Insert image"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <ImageIcon size={14} />
        </button>
        <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={handleAudioFileChange} />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => audioInputRef.current?.click()}
          aria-label="Insert audio"
          title="Upload audio"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <AudioLines size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (recording ? stopRecording() : startRecording())}
          aria-label={recording ? 'Stop recording' : 'Record audio'}
          title={recording ? 'Stop recording' : 'Record audio'}
          className={`rounded p-1 ${
            recording ? 'text-red-400 hover:bg-red-950' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          }`}
        >
          {recording ? <CircleStop size={14} /> : <Mic size={14} />}
        </button>
        </div>
        {/* Positioned at leftFadeOffset (the sticky Undo/Redo group's own
            rendered width), not left-0 — that's the sticky group's own
            territory, already opaque regardless of scroll; this is the
            boundary right where scrolled-away content actually disappears
            out of view underneath it, which is where a fade there
            genuinely means something. */}
        {/* h-[calc(100%-1px)], not bottom-0 — the row's own border-b is
            1px (Tailwind's bare `border-b`), and a fade spanning the full
            anchor height paints its opaque end directly over that border
            pixel (it's a later sibling in the same stacking context, so it
            paints on top). Stopping 1px short leaves the border visible
            underneath instead. */}
        <div
          aria-hidden
          className={`pointer-events-none absolute top-0 h-[calc(100%-1px)] w-8 bg-gradient-to-r from-neutral-900 to-transparent transition-opacity duration-150 ${
            showToolbarFadeLeft ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ left: leftFadeOffset }}
        />
        <div
          aria-hidden
          // rounded-tr-md, matching the outer card's own corner radius —
          // the toolbar is the first thing inside that card, so this
          // fade's own top-right corner coincides with the card's; a plain
          // rectangle there pokes out past the card's rounded curve
          // (confirmed: visibly overhung the border) since the card itself
          // has no overflow-hidden to clip it automatically.
          className={`pointer-events-none absolute right-0 top-0 h-[calc(100%-1px)] w-8 rounded-tr-md bg-gradient-to-l from-neutral-900 to-transparent transition-opacity duration-150 ${
            showToolbarFadeRight ? 'opacity-100' : 'opacity-0'
          }`}
        />
      </div>
      <div ref={tableFadeAnchorRef} className="relative">
        {state.isEmpty && placeholder && (
          <div className="pointer-events-none absolute left-3 top-2 text-sm text-neutral-500">{placeholder}</div>
        )}
        <EditorContent editor={editor} />
        {/* Real overlay fade for each table currently in the editor — see
            the effect that computes tableFades for why these live in React
            state, positioned outside ProseMirror's own DOM, rather than
            being injected into it the way RichText.tsx's read-only display
            safely can. */}
        {tableFades.map((f) => (
          <span key={f.key}>
            <span
              aria-hidden
              className="pointer-events-none absolute bg-gradient-to-r from-neutral-900 to-transparent transition-opacity duration-150"
              style={{ top: f.top, left: f.left, width: TABLE_FADE_WIDTH, height: f.height, opacity: f.showLeft ? 1 : 0 }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute bg-gradient-to-l from-neutral-900 to-transparent transition-opacity duration-150"
              style={{
                top: f.top,
                left: f.left + f.width - TABLE_FADE_WIDTH,
                width: TABLE_FADE_WIDTH,
                height: f.height,
                opacity: f.showRight ? 1 : 0,
              }}
            />
          </span>
        ))}
      </div>
      {mediaError && <p className="px-3 pb-2 text-xs text-red-400">{mediaError}</p>}
      {recordError && <p className="px-3 pb-2 text-xs text-red-400">{recordError}</p>}
      {cropSrc && (
        <ImageCropModal
          src={cropSrc}
          initialAlt={recropAlt}
          initialCrop={recropCrop}
          onCancel={closeCropModal}
          onConfirm={handleCropped}
        />
      )}
      {previewSrc && <ImagePreviewModal src={previewSrc} alt={previewAlt} crop={previewCrop} onClose={closeImagePreview} />}
      {audioEditMediaId && audioEditSrc && (
        <AudioEditModal
          src={audioEditSrc}
          initialAlt={audioEditAlt}
          initialTrimStart={audioEditTrimStart}
          initialTrimEnd={audioEditTrimEnd}
          onCancel={closeAudioEditModal}
          onSave={handleAudioEditSaved}
          onDelete={() => {
            editor.chain().focus().deleteSelection().run();
            closeAudioEditModal();
          }}
        />
      )}
      {pendingAudioBlob && pendingAudioSrc && (
        <AudioEditModal
          src={pendingAudioSrc}
          initialAlt=""
          initialTrimStart={null}
          initialTrimEnd={null}
          onCancel={() => setPendingAudioBlob(null)}
          onSave={(alt, trim) => {
            insertAudio(pendingAudioBlob, alt, trim);
            setPendingAudioBlob(null);
          }}
        />
      )}
      {mathEditing && (
        <MathEditModal
          initialLatex={mathEditing.latex}
          initialDisplay={mathEditing.display}
          onCancel={() => setMathEditing(null)}
          onSave={(latex, display) => {
            if (mathEditing.onSave) {
              mathEditing.onSave(latex, display);
            } else {
              // No onSave closure — this is a fresh insert (the toolbar
              // button's own setMathEditing call, not MathNodeView's),
              // unlike editing an existing node, which always supplies one.
              editor
                .chain()
                .focus()
                .insertContent({ type: display ? 'mathBlock' : 'mathInline', attrs: { latex } })
                .run();
            }
            setMathEditing(null);
          }}
          onDelete={
            mathEditing.onDelete
              ? () => {
                  mathEditing.onDelete!();
                  setMathEditing(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
