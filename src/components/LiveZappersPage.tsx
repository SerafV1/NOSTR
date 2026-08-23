import React, { useEffect, useState } from 'react';
import LiveZappersPanel from './LiveZappersPanel';
import { liveEventAddress } from '../utils/liveStream';
import { CredentialManager } from '../nostr/crypto';

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
  const readOnly = !CredentialManager.isLoggedIn();
  const isOverlaySource = readOnly && transparent;

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
        limit={20}
        hideHeader={isOverlaySource}
        onNavigateToProfile={onNavigateToProfile}
        headerAction={!readOnly ? (
          <span className="live-chat-display-toggles">
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
          </span>
        ) : undefined}
      />
    </div>
  );
};

export default LiveZappersPage;
