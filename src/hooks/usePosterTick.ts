import { useEffect, useState } from 'react';
import { POSTER_REFRESH_MS } from '../utils/liveStream';

const bucket = (every: number): number => Math.floor(Date.now() / every);

/**
 * A number that changes on a beat, for asking a live stream's poster again.
 *
 * One tick serves a whole page of cards, so twenty streams cost one timer
 * rather than twenty, and it stops while the tab is in the background —
 * nobody is looking at a picture they cannot see.
 */
export function usePosterTick(every: number = POSTER_REFRESH_MS): number {
  const [at, setAt] = useState(() => bucket(every));

  useEffect(() => {
    const again = setInterval(() => {
      if (document.visibilityState === 'visible') setAt(bucket(every));
    }, every);
    // Coming back to a tab that was away should not wait out the beat
    const onShow = () => { if (document.visibilityState === 'visible') setAt(bucket(every)); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(again); document.removeEventListener('visibilitychange', onShow); };
  }, [every]);

  return at;
}
