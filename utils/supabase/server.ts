import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { User } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component — safe to ignore since
          // middleware handles session refresh.
        }
      },
    },
  });
}

// A hung/unreachable Supabase auth call here would otherwise leave a media
// API route hanging indefinitely with no response — same failure mode as
// utils/supabase/middleware.ts's own version of this, just for the media
// upload/fetch routes specifically. Racing against a timeout, and treating
// a rejection the same as "no user", means a Supabase hiccup degrades to
// the existing 401 response every caller already handles instead of a
// request that never resolves.
const AUTH_CHECK_TIMEOUT_MS = 3000;

export async function getAuthenticatedUser(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<User | null> {
  const result = await Promise.race([
    supabase.auth.getUser().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), AUTH_CHECK_TIMEOUT_MS)),
  ]);
  return result?.data.user ?? null;
}
