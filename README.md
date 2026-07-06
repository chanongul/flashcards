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

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a free project, then run this SQL in
your project's SQL editor (Supabase dashboard → SQL Editor → paste → run):

```sql
create table events (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  entity_id uuid not null,
  type text not null,
  payload jsonb not null,
  client_id text not null,
  timestamp bigint not null,
  created_at timestamptz default now()
);

create index events_user_id_idx on events (user_id);
create index events_timestamp_idx on events (timestamp);

alter table events enable row level security;

create policy "Users can read their own events"
  on events for select
  using (auth.uid() = user_id);

create policy "Users can insert their own events"
  on events for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own events"
  on events for delete
  using (auth.uid() = user_id);
```

Create your account from the dashboard (Authentication → Users → Add user) with an
email + password — sign-up is intentionally not exposed in the app itself.

### 3. Create a Cloudflare R2 bucket

In the Cloudflare dashboard: R2 → create a bucket, then create an R2 API token
(Account → R2 → Manage API Tokens) scoped to that bucket. You'll need the account ID,
access key ID, secret access key, and bucket name.

### 4. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in:
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Supabase
  project settings → API)
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (from
  step 3)

The same four R2 variables need to be added to your production host's environment
config too, not just `.env.local`.

### 5. Run it

```bash
npm run dev
```

Open http://localhost:3000 and sign in with the account you created in step 2.

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
