# Flashcards

A personal spaced-repetition flashcard app for language learning. Offline-first PWA,
FSRS scheduling, syncs across devices via an append-only event log in Supabase.

## Status: v1 text-only scaffold

What's here:
- Basic + reversed-ready + cloze-ready card data model (only "basic" wired into the UI so far)
- FSRS scheduling via `ts-fsrs` (industry-standard library, not reimplemented from scratch)
- Local-first storage via Dexie (IndexedDB wrapper)
- Event-log sync design: every review/edit is logged as an immutable event, replayed
  in timestamp order to rebuild state — this is what avoids most multi-device conflicts
- Installable PWA shell (manifest + basic service worker for offline app-shell caching)

What's NOT here yet (by design — deferred until text-only is solid):
- Real auth (there's a hardcoded `DEV_USER_ID` placeholder in `app/page.tsx` and
  `app/review/[deckId]/page.tsx` — swap this for Supabase Auth when ready)
- Images/audio (planned: Cloudflare R2 for storage, client-side compression before upload)
- The "Sync Review" conflict UI for same-field edit conflicts / delete-vs-edit races
  (the replay engine in `lib/sync.ts` currently just takes last-write-wins per field,
  which is fine until you're actually using two devices at once)
- A cron/GitHub Actions ping to prevent Supabase's 7-day free-tier pause

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a free project, then run this SQL in
your project's SQL editor (Supabase dashboard → SQL Editor → paste → run). This creates
the `events` table with row-level security so each user can only see their own data.

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
```

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from your
Supabase project settings (Project Settings → API).

### 4. Run it

```bash
npm run dev
```

Open http://localhost:3000.

### 5. Auth

Sign-in is email + password via Supabase Auth (`app/login/page.tsx`). Visiting `/` or
`/review/[deckId]` while signed out redirects to `/login`. Create users from the Supabase
dashboard (Authentication → Users → Add user) with a password. `lib/useUser.ts` exposes
the signed-in user to both pages, which use `user.id` in place of the old `DEV_USER_ID`
placeholder.

## Architecture notes

**Why an event log instead of just storing "current state"?**
Two offline devices reviewing the same card independently can't conflict if you store
"reviewed at time T, rated Good" as an immutable fact rather than "card X's due date is
now Y." Replaying all events in timestamp order on any device produces the same result.
See `lib/sync.ts` → `replayAllEvents()`.

**Why UUIDs everywhere?**
Two offline devices creating new cards can't collide on IDs if IDs are random UUIDs
(`crypto.randomUUID()`) instead of sequential integers.

**Why Dexie/IndexedDB is safe from iOS eviction (mostly):**
Installed PWAs (added to home screen) are exempt from Safari's 7-day inactive-storage
eviction policy. `requestPersistentStorage()` in `lib/db.ts` asks for an extra layer of
protection on top of that. The Supabase event log is your real backup regardless —
a full local wipe just means re-pulling and replaying events on next sign-in.

## Next steps (suggested order)

1. Wire up real Supabase Auth, replace `DEV_USER_ID`
2. Add cloze and reversed card types to the review UI (data model already supports them)
3. Add a basic stats view (reviews today, retention %, cards due forecast)
4. Add the "Sync Review" conflict UI for the rare same-field-edit and delete-vs-edit cases
5. Images: Cloudflare R2 + client-side canvas compression before upload
6. Audio: Web Speech API (free, zero setup) as a v1 pronunciation aid
