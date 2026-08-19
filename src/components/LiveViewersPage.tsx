import React, { useEffect, useState } from 'react';
import { NostrCore } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { parseLiveEvent } from '../utils/liveStream';
import { EVENT_KINDS } from '../types';

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
  const [viewers, setViewers] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // The window OBS loads is signed out; the controls belong in the
  // streamer's own window, or they would be captured with the number
  const readOnly = !CredentialManager.isLoggedIn();

  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;

    const readCount = (event: Parameters<typeof parseLiveEvent>[0]) => {
      const parsed = parseLiveEvent(event);
      if (!cancelled && parsed.currentParticipants !== undefined) {
        setViewers(parsed.currentParticipants);
      }
    };

    (async () => {
      const event = await NostrCore.fetchEventByAddress(kind, pubkey, identifier);
      if (event) readCount(event);
    })();

    // A live event is replaceable and gets republished as the count moves,
    // so the newest one that arrives is the current number
    const subId = NostrCore.subscribeLive(
      [{ kinds: [EVENT_KINDS.LIVE_EVENT], authors: [pubkey], '#d': [identifier] }],
      readCount
    );

    return () => {
      cancelled = true;
      NostrCore.unsubscribeLive(subId);
    };
  }, [kind, pubkey, identifier, relaysConnected]);

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

  const choose = (opts: { transparent: boolean; bold: boolean }) => {
    setTransparent(opts.transparent);
    setBold(opts.bold);
    window.history.replaceState({}, '', window.location.pathname + search(opts));
  };

  const copyLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}${search({ transparent, bold })}`;
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

      {viewers === null && !readOnly && (
        <p className="live-viewers-note">
          This stream doesn't publish a viewer count — not every broadcaster does.
        </p>
      )}
    </div>
  );
};

export default LiveViewersPage;
