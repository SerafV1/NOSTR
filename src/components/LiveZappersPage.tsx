import React, { useEffect, useState } from 'react';
import LiveZappersPanel from './LiveZappersPanel';
import {
  encodeHostParam,
  liveEventAddress,
  parseLiveEvent,
  readdressed
} from '../utils/liveStream';
import { CredentialManager } from '../nostr/crypto';
import { NostrCore } from '../nostr/core';

interface LiveZappersPageProps {
  kind: number;
  pubkey: string;
  identifier: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
}

/**
 * The zappers on their own, for a window beside the video or an OBS browser
 * source — the same shape as the popped-out chat, down to the options it
 * carries and the address it hands out.
 */
const LiveZappersPage: React.FC<LiveZappersPageProps> = ({
  kind,
  pubkey,
  identifier,
  relaysConnected,
  onNavigateToProfile
}) => {
  const params = new URLSearchParams(window.location.search);
  const [transparent, setTransparent] = useState(() => params.get('transparent') === '1');
  const [bold, setBold] = useState(() => params.get('bold') === '1');
  const [copied, setCopied] = useState(false);
  // How many rows to show. In the address as well, so the link handed to OBS
  // brings the same list rather than a default someone has to set again.
  const [top, setTop] = useState(() => {
    const asked = Number(params.get('top'));
    return Number.isFinite(asked) && asked > 0 ? Math.min(asked, 100) : 10;
  });
  /** Whoever presents, for the address this window hands out — see LiveViewersPage */
  const [host, setHost] = useState(pubkey);

  useEffect(() => {
    if (!relaysConnected) return;
    let dropped = false;
    NostrCore.fetchEventByAddress(kind, pubkey, identifier)
      .then(event => {
        if (dropped || !event) return;
        const presenting = parseLiveEvent(event).hostPubkey;
        if (presenting) setHost(presenting);
      })
      .catch(() => { /* then the signer's npub stands in, as before */ });
    return () => { dropped = true; };
  }, [kind, pubkey, identifier, relaysConnected]);

  const readOnly = !CredentialManager.isLoggedIn();
  const isOverlaySource = readOnly && transparent;

  const search = (opts: { transparent: boolean; bold: boolean; top: number }) => {
    const chosen = new URLSearchParams();
    if (opts.transparent) chosen.set('transparent', '1');
    if (opts.bold) chosen.set('bold', '1');
    if (opts.top !== 10) chosen.set('top', String(opts.top));
    const query = chosen.toString();
    return query ? `?${query}` : '';
  };

  // Always the broadcaster's address, never this one broadcast's — see
  // LiveChatPage
  const widgetPath = readdressed(window.location.pathname, encodeHostParam(host));

  const choose = (opts: { transparent: boolean; bold: boolean; top: number }) => {
    setTransparent(opts.transparent);
    setBold(opts.bold);
    setTop(opts.top);
    window.history.replaceState({}, '', widgetPath + search(opts));
  };

  const copyLink = async () => {
    const url = `${window.location.origin}${widgetPath}${search({ transparent, bold, top })}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt('Copy this address:', url);
    }
  };

  // Every painted layer has to be cleared or OBS composites a solid
  // rectangle — the same class the chat overlay uses
  useEffect(() => {
    if (!transparent) return;
    document.documentElement.classList.add('chat-overlay');
    return () => document.documentElement.classList.remove('chat-overlay');
  }, [transparent]);

  return (
    <div
      className={[
        'live-chat-page',
        'live-zappers-page',
        transparent ? 'transparent' : '',
        bold ? 'bold-text' : '',
        isOverlaySource ? 'overlay-source' : ''
      ].filter(Boolean).join(' ')}
    >
      <LiveZappersPanel
        address={liveEventAddress(kind, pubkey, identifier)}
        relaysConnected={relaysConnected}
        limit={top}
        hideHeader={isOverlaySource}
        onNavigateToProfile={onNavigateToProfile}
        headerAction={!readOnly ? (
          <span className="live-chat-display-toggles">
            <label>
              <input
                type="checkbox"
                checked={transparent}
                onChange={(e) => choose({ transparent: e.target.checked, bold, top })}
              />
              Transparent
            </label>
            <label>
              <input
                type="checkbox"
                checked={bold}
                onChange={(e) => choose({ transparent, bold: e.target.checked, top })}
              />
              Bold
            </label>
            <label title="How many zappers to list">
              Top
              <select
                className="live-zappers-count"
                value={top}
                onChange={(e) => choose({ transparent, bold, top: Number(e.target.value) })}
              >
                {[5, 10, 20, 40, 80].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <button type="button" className="live-chat-obs-btn" onClick={copyLink}>
              {copied ? '✓ Copied' : '🔗 Copy link'}
            </button>
          </span>
        ) : undefined}
      />
    </div>
  );
};

export default LiveZappersPage;
