# Flashcards

A personal, offline-first spaced-repetition flashcard app. Installable PWA, FSRS
scheduling, decks and subdecks, rich cards (text/image/audio, cloze deletion, custom
note types), and multi-device sync via an append-only event log — no backend beyond
Supabase (auth + a single `events` table) and Cloudflare R2 (media storage).

## Features

**Decks**
- Nested subdecks (`Parent::Child`, Anki's convention), each with its own daily
  new-card/review limits.
- Per-deck New/Learning/Due counts, rolled up through subdecks.
- Clone a deck (and everything in it) or delete it (cascades to subdecks and their cards).

**Cards**
- **Basic** — front/back, optionally reversed (auto-generates a back→front sibling card).
- **Cloze** — mark one or more blanks in a sentence; each blank either becomes its own
  independently-scheduled card (Anki's default) or all blanks stay together on one card,
  your choice. Reviewing shows the sentence with the active blank as a real fill-in text
  input (self-graded — never checked against the answer); "Show answer" reveals what you
  typed alongside the correct answer, color-coded per blank so repeated blanks in one
  sentence stay distinguishable.
- **Custom note types** — define your own field list, with each field fixed to rich
  text / image / audio, or left "dynamic" (chosen per note, same 3-way toggle Basic uses).
- Rich text: bold/italic/underline + a 4-step font-size scale, sanitized through a
  DOM-based allowlist (never regex) before storage and again at render time.
- Image and audio fields: upload or (for audio) record in-browser, with image cropping,
  a required label (used as the real `alt`/`title` attribute and as searchable text), and
  offline-safe queuing — an attachment only actually uploads to R2 when the card is saved,
  and never orphans a file if you abandon the edit first.
- Flag, suspend, duplicate (into any deck), edit, delete — collapsed behind a single
  "..." menu per card. Delete is hidden on cards generated from another card (a reverse
  sibling, or a non-first cloze blank) — deleting the primary card removes the whole set.
- Automatic leech detection (too many lapses → auto-suspend).

**Review**
- FSRS scheduling via `ts-fsrs`, with full undo of the last review.
- "Study ahead" — review cards before they're actually due, bypassing today's limits;
  temporarily swaps the New/Learning/Due counts to reflect that wider window. Not
  persisted — refreshing mid-session drops back to what's genuinely due today.
- Keyboard shortcuts during review (space to reveal, 1–4 to rate).

**Browse & search**
- Full-text search across all cards (including image/audio labels), by deck, or by tag.
- Favorites-only filter (star).
- Per-deck browse, or a flat "all cards" list — both share one ordering: new cards
  oldest-added-first, then everything else soonest-due-first (not IndexedDB's
  incidental key order, which looks shuffled).

**Import & export**
- Export any deck (or everything) to JSON — doubles as a full backup.
- Import that same JSON shape, or a simple front/back/tags CSV. See
  [Import format](#import-format) for the schema and a ready-to-paste AI prompt.

**Home**
- Today's New/Learning/Due totals across every deck, as a small comparative bar chart.
- A GitHub-style review heatmap for the current year.
- Tap/click the title to trigger a manual sync (push local changes, pull remote ones,
  retry any queued media upload) on demand, on top of the background sync described below.
- A tucked-away "reset everything" action (10 taps on the title to reveal it,
  type-to-confirm) — wipes every deck, card, note type, and review event, locally and
  on the server. No undo.

**Sync & offline**
- Every mutation (card review, edit, deck rename, etc.) is logged as an immutable,
  timestamped event — never a direct state write. `replayAllEvents()` rebuilds all
  local tables from scratch by replaying the full log in timestamp order, which is what
  makes multi-device use mostly self-resolving: two devices replaying the same events
  in the same order always converge on the same state. See "Architecture notes" below.
- Background sync on an interval, and on focus/visibility/reconnect — no manual refresh
  needed to see another device's changes.
- Works fully offline: reviews, edits, and media attachments queue locally and sync once
  back online. Installed as a PWA, IndexedDB is exempt from Safari's inactive-storage
  eviction; `requestPersistentStorage()` asks for an extra layer of protection anyway.

## Tech stack

- **Next.js 15** (App Router) + **React 19**, TypeScript, Tailwind CSS.
- **Dexie** (IndexedDB) for local-first storage; **Supabase** for auth and the event log.
- **Cloudflare R2** (via `@aws-sdk/client-s3`) for image/audio storage, with `sharp` for
  image→WebP conversion and `ffmpeg-static`/`fluent-ffmpeg` for audio→AAC/M4A (the one
  audio format every major browser's `<audio>` element actually supports — notably
  including Safari, which has no Opus support at all).
- **ts-fsrs** for spaced-repetition scheduling.

## Import format

The Import button (⬆, top of the home screen) accepts a JSON file shaped like this:

```json
{
  "notes": [
    {
      "deckName": "Spanish::Verbs",
      "noteType": "basic",
      "front": "to eat",
      "back": "comer",
      "tags": ["food"]
    },
    {
      "deckName": "Spanish::Verbs",
      "noteType": "cloze",
      "front": "Yo {{c1::como}}, tú {{c2::comes}}.",
      "back": "present tense of comer"
    }
  ]
}
```

- `deckName` nests with `::` (`"Parent::Child"`) and is auto-created (max depth 5) — no
  need to declare it separately unless you want to set `newCardsPerDay`/`reviewsPerDay`,
  in which case add a top-level `"decks": [{ "name": "...", "newCardsPerDay": 20 }]`.
- `noteType` is `"basic"` or `"cloze"` (custom note types are also supported via a
  top-level `noteTypes[]` matching `NoteType` in `lib/db.ts`, but that's overkill for a
  quick import).
- Cloze: mark blanks in `front` with `{{c1::answer}}`, `{{c2::answer}}`, etc. — reuse a
  number to keep blanks together on one card, use different numbers to make them
  independently-scheduled cards. `back` is optional extra context, not a second cloze.
- `tags` (string array) and `reversed` (bool, adds a back→front sibling card) are
  optional on either type.
- Front/back accept plain text or only `<b>`, `<i>`, `<u>`, `<br>` — everything else gets
  stripped by the sanitizer. Never fabricate an `<img>`/`<audio data-media-id="...">`:
  those ids only exist for files actually uploaded through the app.
- Never include `id` on a deck or note unless you're intentionally re-importing your own
  earlier export to update it — an `id` means "match my existing entity," and notably
  can't rename a matched deck or move a matched note to a different deck. For anything
  new, omit `id` entirely.

### Writing new cards with AI

Paste everything in the box below into an AI chat (this alone is enough — the AI doesn't
need anything else from this repo), followed by whatever notes/material you want turned
into cards, and ask it to generate the JSON file.

```
I need a JSON file to import into my flashcards app. Schema:

{ "notes": [{ "deckName": "Deck::Subdeck", "noteType": "basic", "front": "...", "back": "...", "tags": ["..."] }] }

Rules:
- noteType is "basic" or "cloze". Basic: plain "front"/"back" strings.
- Cloze: blanks go directly in "front" as {{c1::answer}}, {{c2::answer}}, etc. — reuse a
  number for blanks that should be hidden/revealed together, different numbers for blanks
  that should become separate cards. "back" is optional extra context, not a second cloze.
- deckName nests with "::", e.g. "Spanish::Verbs::Irregular" — it's auto-created.
- No "id" field anywhere — that means "overwrite an existing card," not "create new."
- Front/back: plain text, or only <b>/<i>/<u>/<br> — no other HTML, no images, no audio.
- One note per fact/question, not multiple crammed into one front/back.
- Output ONLY the raw JSON, no code fences or commentary, so I can save it straight to a
  .json file.

Cards for:

<PASTE YOUR NOTES / TEXTBOOK SECTION / TOPIC HERE>
```

Save the AI's output as a `.json` file and import it via the ⬆ button.

## Architecture notes

**Why an event log instead of just storing "current state"?**
Two offline devices reviewing the same card independently can't conflict if you store
"reviewed at time T, rated Good" as an immutable fact rather than "card X's due date is
now Y." Replaying all events in timestamp order on any device produces the same result.
Merges happen at the field level — editing different fields of the same card on two
offline devices merges cleanly; editing the *same* field is resolved by last-write-wins
on the event's (client-generated) timestamp, silently, with no conflict UI. For a
personal app used by one person across their own devices, that's a deliberate
simplification, not an oversight. See `lib/sync.ts` → `replayAllEvents()`.

**Why UUIDs everywhere?**
Two offline devices creating new cards can't collide on IDs if IDs are random UUIDs
(`crypto.randomUUID()`) instead of sequential integers.

**Cards are derived, not stored directly.**
What you edit is a *note* (a set of field values); *cards* — the actual schedulable,
reviewable units — are computed fresh on every replay from the note plus its type: one
card per basic note (two if reversed), one per distinct cloze number, one per
question/answer split for a custom type. This is also why deleting/reverting a note
type change can't corrupt existing cards — they're recomputed, not mutated in place.

**Deletes are soft and sticky.**
Deleting a deck, note type, or note doesn't remove its row from the replay state — it
flags `deleted: true` and keeps it. That flag is never touched by a later edit event, so
a delete can't be silently undone by an edit from another device that raced it (which
*was* a bug for decks/note-types specifically: an edit event used to fully recreate a
deleted entity with default values).

**Media upload is deferred and offline-safe.**
Selecting/recording an image or audio clip only queues it locally (IndexedDB blob); the
actual upload to R2 happens at card-submit time, so canceling an edit never orphans a
file. If the upload fails (offline, transient error), it's retried by the background
sync loop — never by the same editor session again, to avoid a double-upload race.
