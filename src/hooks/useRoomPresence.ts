import { useEffect, useRef, useState } from 'react';
import { NostrCore } from '../nostr/core';
import { PRESENCE_KIND, PRESENT_FOR_MS, fetchPresence } from '../nostr/presence';

/**
 * Who has said they are watching this, in the last ten minutes.
 *
 * Both places that show a viewer count read it from here, so the stream page
 * and the pop-out window cannot disagree — which they did, at length, when
 * each worked presence out for itself.
 */
export function useRoomPresence(address: string, relaysConnected: boolean): string[] {
  const [watching, setWatching] = useState<string[]>([]);
  const seen = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    seen.current = new Map();
    setWatching([]);
    if (!address || !relaysConnected) return;

    let dropped = false;

    const publish = () => {
      if (dropped) return;
      const cutoff = Math.floor((Date.now() - PRESENT_FOR_MS) / 1000);
      for (const [pubkey, at] of seen.current) {
        if (at < cutoff) seen.current.delete(pubkey);
      }
      setWatching([...seen.current.keys()]);
    };

    const note = (pubkey: string, at: number) => {
      if (at > (seen.current.get(pubkey) || 0)) seen.current.set(pubkey, at);
    };

    void fetchPresence(address).then(found => {
      if (dropped) return;
      for (const [pubkey, at] of found) note(pubkey, at);
      publish();
    });

    const since = Math.floor((Date.now() - PRESENT_FOR_MS) / 1000);
    const sub = NostrCore.subscribeLive(
      [{ kinds: [PRESENCE_KIND], '#a': [address], since }],
      event => {
        note(event.pubkey, event.created_at || 0);
        publish();
      }
    );

    // Presence goes stale on its own: somebody who closed the tab stops
    // saying so, and the last thing they said ages out
    const prune = setInterval(publish, 30000);

    return () => {
      dropped = true;
      clearInterval(prune);
      NostrCore.unsubscribeLive(sub);
    };
  }, [address, relaysConnected]);

  return watching;
}
