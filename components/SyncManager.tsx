'use client';

import { useEffect } from 'react';
import { requestPersistentStorage } from '@/lib/db';
import { sync } from '@/lib/sync';
import { useUser } from '@/lib/useUser';

const SYNC_INTERVAL_MS = 30_000;

/** Keeps every device's local store in sync with Supabase without requiring
 * a manual reload — mounted once in the root layout, not per-page, so it
 * runs no matter which screen is open. Runs sync() on mount, on an
 * interval, and whenever the tab/PWA regains focus or visibility (the case
 * that matters most: switching back to an already-open tab after another
 * device pushed changes). */
export function SyncManager() {
  const { user } = useUser();

  useEffect(() => {
    if (!user) return;

    requestPersistentStorage();
    sync(user.id).catch(console.error);

    const runSync = () => sync(user.id).catch(console.error);

    const interval = setInterval(runSync, SYNC_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') runSync();
    };

    window.addEventListener('focus', runSync);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', runSync);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [user]);

  return null;
}
