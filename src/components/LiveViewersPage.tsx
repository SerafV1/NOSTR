import React, { useEffect, useRef, useState } from 'react';
import { NostrCore } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import {
  encodeHostParam,
  parseLiveEvent,
  readdressed
} from '../utils/liveStream';
import { EVENT_KINDS } from '../types';

/** How long after speaking someone still counts as being in the chat */
const PRESENT_FOR_MS = 10 * 60 * 1000;

interface LiveViewersPageProps {
  kind: number;
  pubkey: string;
  identifier: string;
  relaysConnected: boolean;
}

/**
 * Nothing but the viewer count, for pasting into OBS as a browser source
 * beside the chat. The number is the one the streamer's own software
 * publishes on the live event (NIP-53 `current_participants`), which it
 * republishes as the count changes — so this only has to listen.
 *
 * `?transparent=1` clears the background, `?bold=1` sets it heavier.
 */
const LiveViewersPage: React.FC<LiveViewersPageProps> = ({
  kind,
  pubkey,
  identifier,
  relaysConnected
}) => {
  const params = new URLSearchParams(window.location.search);
  const [transparent, setTransparent] = useState(() => params.get('transparent') === '1');
  const [bold, setBold] = useState(() => params.get('bold') === '1');
  const [published, setPublished] = useState<number | null>(null);
  /**
   * Whoever presents. On a platform-published stream the account that signed
   * the event is the platform, and a link built on it carries the platform's
   * npub — which is not the address this broadcaster wants in OBS.
   */
  const [host, setHost] = useState(pubkey);
  /** When the copy the number came from was published, so an older one cannot replace it */
  const latestAt = useRef(0);
  // Everyone heard from in the chat lately — a number that moves on its own,
  // for streams whose broadcaster publishes no count
  const [inChat, setInChat] = useState(0);
  const chatSeen = useRef<Map<string, number>>(new Map());
  const [copied, setCopied] = useState(false);
  // The window OBS loads is signed out; the controls belong in the
  // streamer's own window, or they would be captured with the number
  const readOnly = !CredentialManager.isLoggedIn();

  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;

    const readCount = (event: Parameters<typeof parseLiveEvent>[0]) => {
      // Same guard as the stream page: a broadcaster may run several streams,
      // and a relay that ignores the 'd' filter would answer with the wrong one
      if (event.pubkey !== pubkey) return;
      if (event.tags.find(t => t[0] === 'd')?.[1] !== identifier) return;

      // Every relay answers with the copy it holds, and they are not all
      // at the same revision — one was measured 8 minutes behind another,
      // with a count two viewers lower. Whichever arrives last would
      // otherwise win, which is how this sat on a stale number (0, from
      // when the stream opened) while the broadcaster's own site showed
      // the current one.
      const at = event.created_at || 0;
      if (at < latestAt.current) return;

      const parsed = parseLiveEvent(event);
      if (parsed.hostPubkey) setHost(parsed.hostPubkey);
      if (!cancelled && parsed.currentParticipants !== undefined) {
        latestAt.current = at;
        setPublished(parsed.currentParticipants);
      }
    };

    const refetch = async () => {
      const event = await NostrCore.fetchEventByAddress(kind, pubkey, identifier);
      if (event) readCount(event);
    };
    refetch();

    // A live event is replaceable and gets republished as the count moves —
    // about once a minute on the broadcasters that publish one at all — so
    // the newest one to arrive is the current number.
    const subId = NostrCore.subscribeLive(
      [{ kinds: [EVENT_KINDS.LIVE_EVENT], authors: [pubkey], '#d': [identifier] }],
      readCount
    );

    // A safety net under the subscription: a relay that drops the socket, or
    // never pushes the newer version of a replaceable event, would otherwise
    // freeze the number for the rest of the stream
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') refetch();
    }, 30000);

    // Anyone talking counts as present, which is a number that moves between
    // those republishes — and the only one at all for a stream that
    // publishes none
    const countPresent = () => {
      const cutoff = Date.now() - PRESENT_FOR_MS;
      for (const [author, at] of chatSeen.current) {
        if (at < cutoff) chatSeen.current.delete(author);
      }
      setInChat(chatSeen.current.size);
    };

    const chatSub = NostrCore.subscribeLive(
      [{
        kinds: [EVENT_KINDS.LIVE_CHAT_MESSAGE],
        '#a': [`${kind}:${pubkey}:${identifier}`],
        // Only the window that counts as present — a subscription without
        // this replays the whole chat, and everyone who ever spoke would be
        // counted as here now
        since: Math.floor((Date.now() - PRESENT_FOR_MS) / 1000)
      }],
      (event) => {
        // Stamped with when it was said, not when it reached us, or replayed
        // history would all look like it just arrived
        chatSeen.current.set(event.pubkey, (event.created_at || 0) * 1000);
        countPresent();
      }
    );

    // Presence goes stale: someone who spoke ten minutes ago has moved on
    const prune = setInterval(countPresent, 15000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(prune);
      NostrCore.unsubscribeLive(subId);
      NostrCore.unsubscribeLive(chatSub);
    };
  }, [kind, pubkey, identifier, relaysConnected]);

  /**
   * What to show: the broadcaster's own number, since it counts everyone
   * watching rather than only those who say something — but never less than
   * the number of people talking in the chat.
   *
   * Measured on a stream with people in it: the event said
   * `current_participants: 0` in its newest copy on every relay that had it,
   * while the broadcaster's own page showed two. A published nought while a
   * chat is going is not a count of the room; it is a number that has not
   * been kept up.
   */
  const viewers = Math.max(published ?? 0, inChat) || null;

  useEffect(() => {
    if (!transparent) return;
    document.documentElement.classList.add('chat-overlay');
    return () => document.documentElement.classList.remove('chat-overlay');
  }, [transparent]);

  const search = (opts: { transparent: boolean; bold: boolean }) => {
    const chosen = new URLSearchParams();
    if (opts.transparent) chosen.set('transparent', '1');
    if (opts.bold) chosen.set('bold', '1');
    const query = chosen.toString();
    return query ? `?${query}` : '';
  };

  // Always the broadcaster's address, never this one broadcast's — see
  // LiveChatPage
  const widgetPath = readdressed(window.location.pathname, encodeHostParam(host));

  const choose = (opts: { transparent: boolean; bold: boolean }) => {
    setTransparent(opts.transparent);
    setBold(opts.bold);
    window.history.replaceState({}, '', widgetPath + search(opts));
  };

  const copyLink = async () => {
    const url = `${window.location.origin}${widgetPath}${search({ transparent, bold })}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt('Copy this address:', url);
    }
  };

  return (
    <div
      className={[
        'live-viewers-page',
        transparent ? 'transparent' : '',
        bold ? 'bold-text' : ''
      ].filter(Boolean).join(' ')}
    >
      <div className="live-viewers-count">
        <span className="live-viewers-eye">👁</span>
        <span className="live-viewers-number">
          {viewers === null ? '—' : viewers.toLocaleString()}
        </span>
      </div>

      {!readOnly && (
        <div className="live-viewers-controls">
          <label>
            <input
              type="checkbox"
              checked={transparent}
              onChange={(e) => choose({ transparent: e.target.checked, bold })}
            />
            Transparent
          </label>
          <label>
            <input
              type="checkbox"
              checked={bold}
              onChange={(e) => choose({ transparent, bold: e.target.checked })}
            />
            Bold
          </label>
          <button type="button" className="live-chat-obs-btn" onClick={copyLink}>
            {copied ? '✓ Copied' : '🔗 Copy link'}
          </button>
        </div>
      )}

      {!readOnly && (
        <p className="live-viewers-note">
          {published !== null && published >= inChat
            ? 'The broadcaster publishes this number, and republishes it about once a minute — it follows here as soon as it changes.'
            : viewers !== null
              ? `This is how many people have spoken in the chat in the last ten minutes${
                  published !== null ? ` — the broadcaster's own count says ${published}` : ', since this broadcaster publishes no count'
                }.`
              : 'Waiting for a number: this broadcaster publishes no viewer count, and nobody has spoken in the chat yet.'}
        </p>
      )}
    </div>
  );
};

export default LiveViewersPage;
