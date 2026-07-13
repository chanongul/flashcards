'use client';

import { useEffect, useRef, useState } from 'react';
import { useLoading } from '@/components/GlobalLoading';
import { sync } from './sync';
import { syncPendingMedia } from './mediaSync';
import { hardResync } from './hardResync';

const REFRESH_HOLD_MS = 1_000;
const LONG_HOLD_MS = 5_000;

interface UseTitleSyncOptions {
  userId: string | undefined;
  // Fires once, automatically, the instant a hold reaches LONG_HOLD_MS
  // while still held. Only the homepage passes this (to reveal its
  // "reset all data" button) — other pages just don't, and a hold of any
  // length past REFRESH_HOLD_MS there triggers the hard resync below. When
  // this *is* passed, reaching LONG_HOLD_MS makes the release-time hard
  // resync a no-op instead (mirrors the homepage's original "two gestures
  // on one press, mutually exclusive by duration" design — resyncing would
  // instantly wipe out the very state onLongHold just revealed).
  onLongHold?: () => void;
}

/** Shared "hold the title" gesture, used on every page's title/deck-name
 * heading: a plain click triggers a manual sync-now (push+pull+pending
 * media), a hold past REFRESH_HOLD_MS triggers a hard resync — wipe this
 * device's local IndexedDB entirely and rebuild fresh from Supabase (see
 * lib/hardResync.ts; NOT the same as resetAllData, which destroys the
 * user's actual data everywhere).
 *
 * Both actions require being online: a hard resync in particular is only
 * safe once everything local has actually been confirmed pushed/uploaded
 * (hardResync itself verifies that — see its own doc comment), which can't
 * happen at all while offline, so there's no point letting either gesture
 * even start then. isOnline is exposed so callers can dim/disable the
 * title element to signal that. */
export function useTitleSync({ userId, onLongHold }: UseTitleSyncOptions) {
  const { withLoading } = useLoading();
  const [isOnline, setIsOnline] = useState(true);
  const [syncError, setSyncError] = useState('');
  const pressStartRef = useRef<number | null>(null);
  const longHoldTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  function startPressHoldTimers() {
    if (!isOnline) return;
    pressStartRef.current = Date.now();
    setSyncError('');
    if (onLongHold) {
      if (longHoldTimeout.current) clearTimeout(longHoldTimeout.current);
      longHoldTimeout.current = setTimeout(onLongHold, LONG_HOLD_MS);
    }
  }

  function cancelPressHoldTimers() {
    if (longHoldTimeout.current) clearTimeout(longHoldTimeout.current);
    longHoldTimeout.current = null;
    pressStartRef.current = null;
  }

  async function endPressHoldTimers() {
    const start = pressStartRef.current;
    cancelPressHoldTimers();
    if (start === null || !userId) return;
    const heldMs = Date.now() - start;
    if (heldMs < REFRESH_HOLD_MS) return;
    if (onLongHold && heldMs >= LONG_HOLD_MS) return;

    await withLoading(async () => {
      const result = await hardResync(userId);
      if (!result.ok) {
        setSyncError(
          result.reason === 'offline'
            ? "You're offline — try again once you're back online."
            : "Some changes haven't finished syncing yet — try again in a moment."
        );
      }
    });
  }

  async function handleTitleClick() {
    if (!userId || !isOnline) return;
    setSyncError('');
    await withLoading(async () => {
      await sync(userId);
      await syncPendingMedia(userId);
    });
  }

  return {
    isOnline,
    syncError,
    startPressHoldTimers,
    cancelPressHoldTimers,
    endPressHoldTimers,
    handleTitleClick,
  };
}
