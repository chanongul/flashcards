'use client';

import { useRef } from 'react';

/** Press-and-hold gesture: `start()` on mousedown/touchstart, `cancel()` on
 * mouseup/touchend/touchcancel/mouseleave — fires `onHold` once the press
 * has lasted `holdMs`. `onHold` may return `false` to bail out (e.g. "this
 * name isn't actually truncated, nothing to reveal") without counting as a
 * real trigger.
 *
 * `consumeIfTriggered()` is for the paired onClick handler: releasing a
 * hold always synthesizes a click right after, which needs to be swallowed
 * instead of also acting (e.g. opening a dropdown a hold on the same button
 * was meant to preempt). Checking the trigger flag alone isn't reliable on
 * mobile — releasing a touch-driven hold fires touchend, then a *synthetic
 * mousedown* before the click, and if that mousedown calls `start()` again
 * (the same handler wired to real presses), it resets the flag before the
 * click's guard ever runs. `consumeIfTriggered` falls back to a timestamp
 * window for exactly this case. */
export function useHoldGesture(holdMs: number) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggeredRef = useRef(false);
  const lastTriggeredAtRef = useRef(0);

  function start(onHold: () => boolean | void) {
    cancel();
    triggeredRef.current = false;
    timeoutRef.current = setTimeout(() => {
      const didTrigger = onHold() !== false;
      if (didTrigger) {
        triggeredRef.current = true;
        lastTriggeredAtRef.current = Date.now();
      }
    }, holdMs);
  }

  function cancel() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    // Refresh the fallback timestamp at release time too, not just at the
    // moment the hold first triggered: some gestures (e.g. the name-reveal
    // carousel) are meant to be held well past their trigger point, so the
    // synthetic click that follows release can land long after the
    // original `withinMs` window from the trigger has already expired.
    if (triggeredRef.current) {
      lastTriggeredAtRef.current = Date.now();
    }
  }

  function consumeIfTriggered(withinMs = 600): boolean {
    if (triggeredRef.current || Date.now() - lastTriggeredAtRef.current < withinMs) {
      triggeredRef.current = false;
      return true;
    }
    return false;
  }

  return { start, cancel, consumeIfTriggered };
}
