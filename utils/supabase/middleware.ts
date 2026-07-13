import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// This middleware runs on nearly every navigation (see middleware.ts's
// matcher) — an unbounded, un-caught auth.getUser() call below would mean
// a slow or unreachable Supabase auth service doesn't just fail to refresh
// one session cookie, it hangs or 500s every single page request across
// the whole app, for every user, regardless of whether *they* have
// connectivity (mirrors lib/useUser.ts's own client-side version of this
// same problem, just server-side and triggered by Supabase's health
// instead of the client's). Racing it against a timeout, and swallowing a
// rejection instead of letting it propagate, degrades a Supabase hiccup to
// "the session cookie doesn't get refreshed this one request" instead of
// taking the app down.
const AUTH_CHECK_TIMEOUT_MS = 3000;

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Refreshes the session cookie if needed; touching auth.getUser() is
  // required to trigger this (per Supabase SSR docs) even though the
  // result isn't used here yet.
  await Promise.race([
    supabase.auth.getUser().catch(() => null),
    new Promise((resolve) => setTimeout(resolve, AUTH_CHECK_TIMEOUT_MS)),
  ]);

  return supabaseResponse;
}
