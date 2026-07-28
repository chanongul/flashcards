'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import type { User } from '@supabase/supabase-js';

interface UserContextValue {
  user: User | null;
  loading: boolean;
}

const UserContext = createContext<UserContextValue | null>(null);

// Mounted once at the root layout — every page previously called useUser()
// itself, which meant this whole auth check (including the network-bound
// getUser() call below) re-ran from scratch on every single client-side
// navigation, since a page component unmounts/remounts on route change
// while a layout doesn't. That's what made navigating between pages feel
// like it froze for a moment: every page's `if (loading || !user) return
// null` gated its entire render behind a fresh round trip. Resolving it
// once here and sharing the result via context means only the very first
// load pays that cost — every navigation after that reads an already-
// resolved value synchronously. Also fixes SyncManager (mounted at the
// same root level) previously firing its own separate getUser() call on
// top of whatever page was active, doubling the redundant network hit on
// first load.
export function UserProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // getUser() always hits the network to revalidate the session against
    // the server — with no connectivity that call rejects, and without a
    // .catch() the rejection was silently swallowed, leaving `loading`
    // stuck true forever (this app renders nothing until it resolves — see
    // every page's `if (loading || !user) return null;`). This app is
    // local-first and should still open with no connectivity as long as
    // there's a previously-persisted session, rather than hanging or
    // locking the user out of their own local data just because the
    // network's down — so a failed revalidation falls back to whatever
    // session is already cached locally (getSession() reads from storage
    // and doesn't itself require network) instead of assuming "logged
    // out". The finally block is what actually guarantees loading always
    // resolves either way.
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (!data.user) {
          router.replace('/login');
        } else {
          setUser(data.user);
        }
      })
      .catch(() =>
        supabase.auth
          .getSession()
          .then(({ data }) => {
            if (data.session?.user) {
              setUser(data.session.user);
            } else {
              router.replace('/login');
            }
          })
          .catch(() => router.replace('/login'))
      )
      .finally(() => setLoading(false));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setUser(null);
        router.replace('/login');
      } else {
        setUser(session.user);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [router]);

  return <UserContext.Provider value={{ user, loading }}>{children}</UserContext.Provider>;
}

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used inside UserProvider');
  return ctx;
}
