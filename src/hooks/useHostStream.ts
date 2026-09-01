import { useEffect, useRef, useState } from 'react';
import { NostrCore } from '../nostr/core';
import { EVENT_KINDS } from '../types';
import { decodeHostParam, decodeLiveNaddr, isEffectivelyLive } from '../utils/liveStream';

export interface StreamAddress {
  kind: number;
  pubkey: string;
  identifier: string;
}

export type StreamTarget =
  /** A link to one particular broadcast */
  | { state: 'found'; address: StreamAddress; host?: string }
  /** A link that follows a broadcaster who is not on air yet */
  | { state: 'waiting'; host: string }
  /** Neither an naddr nor an npub */
  | { state: 'unreadable' };

/** How often to ask again, under the subscription */
const ASK_AGAIN_MS = 30_000;

/**
 * The last stream each broadcaster was seen on.
 *
 * A browser source in OBS is reopened constantly — every scene reload, every
 * restart — and each time it sat blank for a couple of seconds while the
 * relays were asked which stream to show. The last answer is kept so the
 * window can start on it immediately; if the relays disagree, the newer
 * stream replaces it a moment later, which is the same thing that happens
 * when a broadcast starts while the window is open.
 */
const REMEMBERED = 'razr_host_stream';

const rememberedFor = (host: string): StreamAddress | null => {
  try {
    const held = JSON.parse(localStorage.getItem(REMEMBERED) || '{}') as Record<string, StreamAddress>;
    const found = held[host];
    return found?.pubkey && typeof found.identifier === 'string' ? found : null;
  } catch {
    return null;
  }
};

const remember = (host: string, address: StreamAddress): void => {
  try {
    const held = JSON.parse(localStorage.getItem(REMEMBERED) || '{}') as Record<string, StreamAddress>;
    held[host] = address;
    // Only the last few matter; nobody watches thirty broadcasters at once
    const trimmed = Object.fromEntries(Object.entries(held).slice(-10));
    localStorage.setItem(REMEMBERED, JSON.stringify(trimmed));
  } catch {
    // A browser that will not store it simply asks again next time
  }
};

/**
 * What a `/live/<something>/…` link points at.
 *
 * The something is either one broadcast (an naddr, which changes every time
 * the broadcaster goes on air) or the broadcaster themselves (an npub, which
 * never changes). The second is what a browser source in OBS wants: set it
 * up once, and every later stream turns up in the same window — the chat
 * empties and refills with the new stream's own, because the address behind
 * it moved.
 *
 * A stream that ends is held onto rather than dropped: the chat of what was
 * just on stays readable until the next broadcast starts, instead of the
 * overlay going blank the moment the broadcaster stops.
 */
export function useHostStream(param: string | undefined, relaysConnected: boolean): StreamTarget {
  const pinned = param ? decodeLiveNaddr(param) : null;
  const host = !pinned && param ? decodeHostParam(param) : null;

  const [found, setFound] = useState<StreamAddress | null>(() => (host ? rememberedFor(host) : null));
  // What the current pick is worth, so a stale copy of an old stream cannot
  // pull the window back off a newer one
  const standing = useRef<{ address: string; at: number; live: boolean } | null>(null);

  useEffect(() => {
    standing.current = null;
    setFound(host ? rememberedFor(host) : null);
  }, [host]);

  useEffect(() => {
    if (!host || !relaysConnected) return;
    let dropped = false;

    const consider = (event: Parameters<typeof isEffectivelyLive>[0]) => {
      if (dropped) return;
      const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
      const address = `${event.pubkey}:${dTag}`;
      const at = event.created_at || 0;
      const live = isEffectivelyLive(event);
      const held = standing.current;

      // The same stream again, with a newer count or an "ended": worth
      // knowing, but it does not move the window
      if (held && held.address === address) {
        if (at >= held.at) standing.current = { address, at, live };
        return;
      }

      // Another stream only takes the window if it is actually on air —
      // otherwise an old broadcast sitting on a relay would replace the one
      // being watched
      if (!live) return;
      if (held?.live && held.at > at) return;

      standing.current = { address, at, live };
      const now = { kind: EVENT_KINDS.LIVE_EVENT, pubkey: event.pubkey, identifier: dTag };
      remember(host, now);
      setFound(now);
    };

    const ask = async () => {
      const streams = await NostrCore.fetchStreamsHostedBy(host);
      // Newest first, so the last one considered is the oldest — and a live
      // one among them wins by the rule above
      streams.slice().reverse().forEach(consider);
    };
    void ask();

    const sub = NostrCore.subscribeLive(
      [
        { kinds: [EVENT_KINDS.LIVE_EVENT], authors: [host] },
        { kinds: [EVENT_KINDS.LIVE_EVENT], '#p': [host] }
      ],
      event => {
        // A `p` tag is not proof of hosting; the fetch checks the role, and
        // so does this
        if (event.pubkey === host || event.tags.some(t => t[0] === 'p' && t[1] === host)) consider(event);
      }
    );

    // A relay that drops the socket, or never pushes the new stream's first
    // copy, would otherwise leave the window on last night's broadcast
    const again = setInterval(() => {
      if (document.visibilityState === 'visible') void ask();
    }, ASK_AGAIN_MS);

    return () => {
      dropped = true;
      clearInterval(again);
      NostrCore.unsubscribeLive(sub);
    };
  }, [host, relaysConnected]);

  if (pinned) return { state: 'found', address: pinned, host: pinned.pubkey };
  if (!host) return { state: 'unreadable' };
  return found ? { state: 'found', address: found, host } : { state: 'waiting', host };
}
