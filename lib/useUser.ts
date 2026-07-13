'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import type { User } from '@supabase/supabase-js';

export function useUser() {
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

  return { user, loading };
}
