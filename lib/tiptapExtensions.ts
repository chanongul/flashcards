// Custom Tiptap schema for the 'richtext' field type (see
// components/TiptapFieldInput.tsx) — deliberately narrow, producing exactly
// the tag/attribute vocabulary lib/sanitize.ts already allows (b/i/u/br/
// span[data-size]/span[data-color]/span[data-dim]) instead of Tiptap's own
// defaults (<strong>/<em>, style-based color) — so content is stored and
// rendered identically to the old RichTextInput (removed), only the editing
// widget changed. This file holds the original inline-only pieces (marks,
// media, HardBreak); the doc node itself and every block-level construct
// (paragraph/blockquote/lists/code block/horizontal rule/table/math) live
// in lib/tiptapBlockExtensions.ts — see BlockDoc's own doc comment there for
// why those needed a real schema change rather than just a new node type.
import { Mark, mergeAttributes } from '@tiptap/core';
import { HardBreak as BaseHardBreak } from '@tiptap/extension-hard-break';
import BaseImage from '@tiptap/extension-image';
import BaseAudio from '@tiptap/extension-audio';

export const Bold = Mark.create({
  name: 'bold',
  parseHTML: () => [{ tag: 'b' }, { tag: 'strong' }],
  renderHTML: ({ HTMLAttributes }) => ['b', mergeAttributes(HTMLAttributes), 0],
  addKeyboardShortcuts() {
    return { 'Mod-b': () => this.editor.commands.toggleMark(this.name) };
  },
});

export const Italic = Mark.create({
  name: 'italic',
  parseHTML: () => [{ tag: 'i' }, { tag: 'em' }],
  renderHTML: ({ HTMLAttributes }) => ['i', mergeAttributes(HTMLAttributes), 0],
  addKeyboardShortcuts() {
    return { 'Mod-i': () => this.editor.commands.toggleMark(this.name) };
  },
});

export const Underline = Mark.create({
  name: 'underline',
  parseHTML: () => [{ tag: 'u' }],
  renderHTML: ({ HTMLAttributes }) => ['u', mergeAttributes(HTMLAttributes), 0],
  addKeyboardShortcuts() {
    return { 'Mod-u': () => this.editor.commands.toggleMark(this.name) };
  },
});

// Opacity-based de-emphasis, independent of color — the toolbar has a
// dedicated toggle for it. No attributes: presence of the tag/attribute is
// the whole signal, same as lib/sanitize.ts's `el.hasAttribute('data-dim')`
// check.
export const Dim = Mark.create({
  name: 'dim',
  parseHTML: () => [{ tag: 'span[data-dim]' }],
  renderHTML: () => ['span', { 'data-dim': '' }, 0],
});

// Fixed steps (see lib/sanitize.ts's FONT_SIZE_VALUES) — not free-form CSS,
// same reasoning as the existing editor: a handful of fixed sizes is all
// this needs, and arbitrary values are a needless risk/consistency problem.
export const FontSize = Mark.create({
  name: 'fontSize',
  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-size'),
        renderHTML: (attrs: { size?: string | null }) =>
          attrs.size ? { 'data-size': attrs.size } : {},
      },
    };
  },
  parseHTML: () => [{ tag: 'span[data-size]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes), 0],
});

// Fixed palette (lib/richTextModel.ts's COLOR_PALETTE) via a key attribute,
// not an inline style — matches lib/sanitize.ts's ALLOWED_COLORS check
// against `data-color`, and lets the same CSS in globals.css that already
// renders [data-color="key"] for the old editor's output render this too.
export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-color'),
        renderHTML: (attrs: { color?: string | null }) =>
          attrs.color ? { 'data-color': attrs.color } : {},
      },
    };
  },
  parseHTML: () => [{ tag: 'span[data-color]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes), 0],
});

// The stock extension's own default already binds exactly what's wanted now
// that real block content exists (see lib/tiptapBlockExtensions.ts):
// Shift-Enter/Mod-Enter insert a <br> (a soft break within the current
// paragraph); plain Enter is left alone, falling through to
// BlockEssentials' baseKeymap binding (splitBlock — start a new paragraph),
// standard editor behavior once there's a block to split. An earlier
// version of this rebound plain Enter to setHardBreak too, back when the
// doc had no paragraph node at all for Enter to usefully split.
export const HardBreak = BaseHardBreak;

// Extends Tiptap's own official Image node — reusing its battle-tested
// atomic-node/selection/paste handling rather than writing an inline media
// node from scratch — with the two things it doesn't already know about:
// data-media-id, this app's identifier for a queued/uploaded file (see
// lib/mediaSync.ts), and width (the resize handle's display-size override,
// see TiptapFieldInput's ImageNodeView). `inline: true` overrides the
// extension's own default (block) so it can live inside FlatDoc's
// inline-only content model, mixed with text like any other inline element.
//
// `src` stays a normal tracked attribute — Tiptap parses/renders/copies it
// like any other image — but it's never *trusted* from stored content: a
// pending (not-yet-uploaded) id has no real URL yet (TiptapFieldInput
// rehydrates a live blob: URL for it, the same lib/mediaRehydrate.ts
// rehydratePendingMedia used for read-only display already does), and an
// uploaded id's URL is always regenerated from the id by sanitizeRichText
// on save regardless of whatever src the live editor happened to have —
// matching lib/sanitize.ts's own "never trust a stored src" rule for
// exactly the same reason (closing off arbitrary external src injection).
export const MediaImage = BaseImage.extend({
  // The base extension sets this true at the node-SPEC level (distinct
  // from the DOM img's own `draggable` attribute, which ImageNodeView
  // separately renders false) — nothing here uses native HTML5 drag, and
  // leaving it on has a real cost: ProseMirror's own mousedown handling
  // special-cases draggable nodes (there's literally a "Safari ignores
  // clicks on draggable elements" comment in its source for this exact
  // node-spec flag), and forces the DOM element's `draggable` attribute
  // true for the duration of the gesture regardless of what a NodeView
  // rendered — which made a plain tap unreliably fail to produce a
  // NodeSelection at all (confirmed empirically: posAtCoords correctly
  // found the image, but the click still resolved to a nearby
  // TextSelection instead of selecting it). This was already latent
  // before ImageNodeView's tap-to-select redesign; it just never showed up
  // because the old click handling opened the crop modal directly off of
  // whatever node was hit, without depending on PM's own selection
  // outcome the way ImageNodeView's selected-gated controls now do.
  draggable: false,
  addOptions() {
    return {
      ...this.parent!(),
      inline: true,
    };
  },
  // Bridge for ImageNodeView (module scope, shared by every editor
  // instance — see MediaAudio's addStorage below for the same pattern,
  // there since audio's native <audio controls> needs its own click
  // target; here since a tap now only *selects* the image, and a
  // dedicated crop button — shown once selected — is what actually opens
  // the edit modal, so that button needs a way back into this specific
  // TiptapFieldInput instance's modal state).
  addStorage() {
    return {
      openEditor: null as
        | ((mediaId: string, alt: string, crop: { x: number; y: number; w: number; h: number } | null) => void)
        | null,
      // Same bridge shape as openEditor above, for a click on an already-
      // selected image (see ImageNodeView's own doc comment) opening a
      // full-screen preview instead of the crop editor.
      openPreview: null as
        | ((mediaId: string, alt: string, crop: { x: number; y: number; w: number; h: number } | null) => void)
        | null,
    };
  },
  addAttributes() {
    return {
      ...this.parent!(),
      'data-media-id': {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-media-id'),
        renderHTML: (attrs: { 'data-media-id'?: string | null }) =>
          attrs['data-media-id'] ? { 'data-media-id': attrs['data-media-id'] } : {},
      },
      // Percent of the field's own width, dragged via ImageNodeView's
      // resize handle — null (the default, and what every pre-existing
      // image has) means "natural size, capped to 100% of the field" via
      // the plain `.rich-text-content img { max-width: 100% }` CSS rule,
      // same as before this was introduced, so no stored card needed
      // touching. Rendered as an inline style (a number we've already
      // clamped, not copied from anywhere untrusted) rather than a CSS
      // class, since it's a continuous value, not one of a handful of
      // fixed steps like fontSize/textColor.
      width: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-width');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs: { width?: number | null }) =>
          attrs.width
            ? { 'data-width': String(attrs.width), style: `width: ${attrs.width}%` }
            : {},
      },
      // The crop rectangle ImageCropModal's frame produces, as fractions
      // (0-1) of the *original* image's own natural dimensions — resolution
      // independent, so it stays correct regardless of what size the
      // original actually is. All four null (the default, and what every
      // pre-existing image has) means "show the whole original". Never
      // baked into a new file — `src`/data-media-id always point at the
      // full original (app/api/media/upload/image/route.ts doesn't cut
      // anything), so cropping never permanently discards image data, and
      // adjusting the crop later is just an attribute update, not a new
      // upload. ImageNodeView (editor) and RichText.tsx (review display)
      // are both responsible for actually rendering just this rectangle at
      // render time — see ImageNodeView's own doc comment for the CSS
      // approach (an absolutely-positioned, scaled img inside an
      // aspect-ratio'd, overflow:hidden wrapper).
      cropX: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-crop-x');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs: { cropX?: number | null }) => (attrs.cropX != null ? { 'data-crop-x': String(attrs.cropX) } : {}),
      },
      cropY: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-crop-y');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs: { cropY?: number | null }) => (attrs.cropY != null ? { 'data-crop-y': String(attrs.cropY) } : {}),
      },
      cropWidth: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-crop-w');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs: { cropWidth?: number | null }) =>
          attrs.cropWidth != null ? { 'data-crop-w': String(attrs.cropWidth) } : {},
      },
      cropHeight: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-crop-h');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs: { cropHeight?: number | null }) =>
          attrs.cropHeight != null ? { 'data-crop-h': String(attrs.cropHeight) } : {},
      },
    };
  },
  // The base extension's own parseHTML requires `img[src]` — but a pending
  // (not-yet-uploaded) image's stored HTML deliberately has NO src (see the
  // doc comment above), so that rule alone would silently fail to parse
  // exactly the content this whole src-is-never-trusted design produces.
  // data-media-id, not src, is this app's actual source of truth for what
  // makes a stored <img> valid — matching lib/sanitize.ts's own check.
  parseHTML() {
    return [{ tag: 'img[data-media-id]' }];
  },
});

// Same convention Tiptap's own extensions use for adding a new command
// (e.g. BaseImage's `setImage`) — augments the core `Storage` interface so
// `editor.storage.image`/`editor.storage.audio` are fully typed instead of
// needing a cast at every call site.
declare module '@tiptap/core' {
  interface Storage {
    image: {
      // crop: that node's current crop rectangle (null if uncropped), so
      // the edit modal's frame can preload the existing selection instead
      // of always starting from the whole image.
      openEditor:
        | ((mediaId: string, alt: string, crop: { x: number; y: number; w: number; h: number } | null) => void)
        | null;
      // Same crop param, for the same reason: a full-screen preview of a
      // cropped image should show the crop, not the whole original behind
      // it — see ImagePreviewModal in components/MediaShared.tsx.
      openPreview:
        | ((mediaId: string, alt: string, crop: { x: number; y: number; w: number; h: number } | null) => void)
        | null;
    };
    audio: {
      // trimStart/trimEnd: that node's current trim range (null/null if
      // untrimmed), so the edit modal's waveform can preload the existing
      // selection instead of always starting from the full clip.
      openEditor: ((mediaId: string, alt: string, trimStart: number | null, trimEnd: number | null) => void) | null;
    };
  }
}

// Extends Tiptap's own official Audio node (@tiptap/extension-audio) —
// same reasoning as MediaImage extending the official Image, and the exact
// same shape of fix: add data-media-id (this app's identifier for a
// queued/uploaded file) and title (audio has no `alt`; this is the
// required accessibility label, same convention as lib/sanitize.ts's own
// AUDIO handling), then override parseHTML for the same pending-media gap
// MediaImage's own doc comment explains — the base rule requires a real
// `src`, but a pending (not-yet-uploaded) audio's stored HTML deliberately
// has none yet.
//
// `controls` stays forced on via the extension's own OPTION (not a per-
// node attribute the base renderHTML ignores anyway) — matches
// lib/sanitize.ts's own AUDIO handling, which forces this regardless of
// what's stored, so content can never render as invisible or self-playing.
export const MediaAudio = BaseAudio.extend({
  // Same fix, same reasoning as MediaImage's own `draggable: false` above —
  // nothing here uses native HTML5 drag, and this node-spec flag (not the
  // DOM element's own draggable attribute) is what caused that click-
  // selection bug for images. Audio's own interaction never depended on
  // default node click-to-select in the first place (see AudioNodeView's
  // doc comment on why it needs its own click target at all), so this is
  // preventive rather than a fix for an observed bug here — but it's the
  // exact same latent hazard, so there's no reason to leave it on.
  draggable: false,
  addOptions() {
    return {
      ...this.parent!(),
      inline: true,
    };
  },
  // Bridge for AudioNodeView (module scope, shared by every editor
  // instance) to reach back into this specific instance's modal state —
  // see MediaImage's own addStorage above for the identical pattern, and
  // AudioNodeView's doc comment in TiptapFieldInput.tsx for why audio
  // needs this (a native <audio controls> element's own play/seek UI
  // intercepts clicks before ProseMirror's click handling ever sees them,
  // unlike a plain <img>, so it needs its own dedicated click target
  // instead of a handleClickOn hook).
  addStorage() {
    return {
      openEditor: null as ((mediaId: string, alt: string) => void) | null,
    };
  },
  addAttributes() {
    return {
      ...this.parent!(),
      title: { default: null },
      'data-media-id': {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-media-id'),
        renderHTML: (attrs: { 'data-media-id'?: string | null }) =>
          attrs['data-media-id'] ? { 'data-media-id': attrs['data-media-id'] } : {},
      },
      // Percent of the field's own width, dragged via AudioNodeView's
      // resize handle — same shape as MediaImage's own `width` attr, but
      // null means 100% here (audio's own field-forced default), not
      // "natural size" the way it does for images (see MIN/MAX_AUDIO_
      // WIDTH_PERCENT's doc comment in lib/richTextModel.ts for why audio
      // has no equivalent natural size to fall back to).
      width: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-width');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs: { width?: number | null }) =>
          attrs.width
            ? { 'data-width': String(attrs.width), style: `width: ${attrs.width}%` }
            : {},
      },
      // Seconds into the clip, set via TiptapFieldInput's wavesurfer-based
      // trim UI — null (the default, and what every pre-existing audio
      // node has) means "play the whole thing", so no stored card needed
      // touching when this was introduced. Always read/written as a pair
      // (see lib/sanitize.ts's own trimStart/trimEnd handling for why) —
      // there's no real scenario where only one of the two is meaningful.
      // Deliberately non-destructive: this is pure playback metadata, never
      // applied to the actual file — `src`/data-media-id always point at
      // the full, untrimmed original (app/api/media/upload/audio/route.ts
      // doesn't cut anything), so trimming never permanently discards
      // audio, and adjusting the range later is just an attribute update,
      // not a re-upload. AudioNodeView (editor) and RichText.tsx (review
      // display) are both responsible for actually respecting this at
      // render/playback time.
      trimStart: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-trim-start');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs: { trimStart?: number | null }) =>
          attrs.trimStart != null ? { 'data-trim-start': String(attrs.trimStart) } : {},
      },
      trimEnd: {
        default: null as number | null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-trim-end');
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs: { trimEnd?: number | null }) =>
          attrs.trimEnd != null ? { 'data-trim-end': String(attrs.trimEnd) } : {},
      },
    };
  },
  // The base extension's own parseHTML requires `audio[src]` — but a
  // pending (not-yet-uploaded) audio's stored HTML deliberately has no src
  // (see MediaImage's identical fix above for the full reasoning).
  // data-media-id, not src, is this app's actual source of truth for what
  // makes a stored <audio> valid — matching lib/sanitize.ts's own check.
  parseHTML() {
    return [{ tag: 'audio[data-media-id]' }];
  },
});
