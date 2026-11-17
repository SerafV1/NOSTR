import { useEffect, useState } from 'react';

/**
 * Whose turn it is to play.
 *
 * Only one stream in a feed plays at a time: two sounding at once, or two
 * docked players stacked in one corner, is nobody's idea of watching. Taking
 * the turn stops whoever had it.
 */
let stopCurrent: (() => void) | null = null;
const FREE = 'razr-stream-turn-free';

export const somebodyPlaying = (): boolean => stopCurrent !== null;

/** Take the turn; the function returned gives it back */
export function takeTurn(stop: () => void): () => void {
  if (stopCurrent !== stop) stopCurrent?.();
  stopCurrent = stop;
  return () => {
    if (stopCurrent !== stop) return;
    stopCurrent = null;
    // A stream waiting on screen may start now
    window.dispatchEvent(new Event(FREE));
  };
}

/** Whether this browser has asked to be careful with data */
const savingData = (): boolean => {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!connection?.saveData;
};

/**
 * Whether a stream in a note should start by itself: it is on screen, and
 * nothing else is playing.
 *
 * A stream used to wait for a press, so the feed could not end up pulling
 * several at once for as long as the page stayed open. Starting only the one
 * in view, muted, and stopping it once it is scrolled past keeps that promise
 * without making anybody press play to see who is live.
 */
export function useStartWhenSeen(element: HTMLElement | null, able: boolean): boolean {
  const [seen, setSeen] = useState(false);
  const [, setFreeTick] = useState(0);

  useEffect(() => {
    if (!element || !able || savingData()) {
      setSeen(false);
      return;
    }
    // Two thresholds so a card sitting on the edge does not flicker
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.6) setSeen(true);
        else if (entry.intersectionRatio < 0.15) setSeen(false);
      },
      { threshold: [0, 0.15, 0.6, 1] }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, able]);

  useEffect(() => {
    const onFree = () => setFreeTick(t => t + 1);
    window.addEventListener(FREE, onFree);
    return () => window.removeEventListener(FREE, onFree);
  }, []);

  return seen;
}
