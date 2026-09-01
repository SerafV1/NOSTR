import React, { useEffect, useState } from 'react';
import LiveChatPanel from './LiveChatPanel';
import {
  decodeLiveNaddr,
  encodeHostParam,
  encodeLiveNaddr,
  liveEventAddress,
  parseLiveEvent,
  readdressed
} from '../utils/liveStream';
import { CredentialManager } from '../nostr/crypto';
import { NostrCore } from '../nostr/core';

interface LiveChatPageProps {
  kind: number;
  relaysConnected: boolean;
  pubkey: string;
  identifier: string;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

/**
 * The stream's chat on its own, for a window you keep beside the video —
 * a second screen, half a desktop, or an OBS browser source. Nothing else is
 * on the page, so it stays readable at the width a chat window actually gets.
 *
 * `?transparent=1` drops the background, for laying the chat over the video
 * in a stream overlay.
 */
const LiveChatPage: React.FC<LiveChatPageProps> = ({
  kind,
  pubkey,
  identifier,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic
}) => {
  const params = new URLSearchParams(window.location.search);
  const [transparent, setTransparent] = useState(() => params.get('transparent') === '1');
  // Over a moving picture, heavier text carries better
  const [bold, setBold] = useState(() => params.get('bold') === '1');
  // Whether this window is on the broadcaster or on this one broadcast. A
  // stream gets a new `d` tag every time it starts, so an address built on
  // one is a link that has to be pasted into OBS again tomorrow; an npub in
  // its place is set up once and left alone.
  const [following, setFollowing] = useState(
    () => !decodeLiveNaddr(window.location.pathname.split('/')[2] || '')
  );
  // Who runs the stream, so this window honours its mute list too — and
  // offers it, if the person watching here is the one who runs it. Without
  // this the popped-out chat, the one an overlay actually shows, ignored
  // every moderation decision made on the page it came from.
  const [owners, setOwners] = useState<string[]>([pubkey]);
  // In an overlay nobody can type, and the box would only take up room
  const readOnly = !CredentialManager.isLoggedIn();
  // The window OBS itself loads: signed out and transparent. There the header
  // has no business being on screen — it would be captured with the chat.
  const isOverlaySource = readOnly && transparent;
  // Whatever is on screen is what OBS will show, so the address handed over
  // carries the same choice
  const search = (opts: { transparent: boolean; bold: boolean }) => {
    const chosen = new URLSearchParams();
    if (opts.transparent) chosen.set('transparent', '1');
    if (opts.bold) chosen.set('bold', '1');
    const query = chosen.toString();
    return query ? `?${query}` : '';
  };

  // The two ways to say the same window: this broadcast, or whoever is
  // presenting it
  const pathFor = (follow: boolean) => readdressed(
    window.location.pathname,
    follow ? encodeHostParam(pubkey) : encodeLiveNaddr(kind, pubkey, identifier)
  );

  const obsLink = readOnly
    ? undefined
    : `${window.location.origin}${pathFor(following)}${search({ transparent, bold })}`;

  // Kept in the address so a reload — and the copied link — agree with what
  // is on screen
  const choose = (opts: { transparent: boolean; bold: boolean; following: boolean }) => {
    setTransparent(opts.transparent);
    setBold(opts.bold);
    setFollowing(opts.following);
    window.history.replaceState({}, '', pathFor(opts.following) + search(opts));
  };

  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;
    NostrCore.fetchEventByAddress(kind, pubkey, identifier).then(event => {
      // The presenter is not always the account that signed the event
      if (event && !cancelled) setOwners([pubkey, parseLiveEvent(event).hostPubkey]);
    });
    return () => { cancelled = true; };
  }, [kind, pubkey, identifier, relaysConnected]);

  // The page sits on several painted layers — body, the app shell, the
  // scrolling main — and every one of them has to be cleared or OBS gets a
  // solid rectangle. Marking the root element rather than matching upwards
  // with :has(), which OBS's embedded browser may be too old to support.
  useEffect(() => {
    if (!transparent) return;
    document.documentElement.classList.add('chat-overlay');
    return () => document.documentElement.classList.remove('chat-overlay');
  }, [transparent]);

  return (
  <div className={[
    'live-chat-page',
    transparent ? 'transparent' : '',
    bold ? 'bold-text' : '',
    isOverlaySource ? 'overlay-source' : ''
  ].filter(Boolean).join(' ')}>
    <LiveChatPanel
      address={liveEventAddress(kind, pubkey, identifier)}
      relaysConnected={relaysConnected}
      hideComposer={readOnly}
      owners={owners}
      identifier={identifier}
      obsLink={obsLink}
      transparent={readOnly ? undefined : transparent}
      bold={readOnly ? undefined : bold}
      following={readOnly ? undefined : following}
      onDisplayChange={readOnly ? undefined : choose}
      onNavigateToProfile={onNavigateToProfile}
      onNavigateToNote={onNavigateToNote}
      onNavigateToTopic={onNavigateToTopic}
    />
  </div>
  );
};

export default LiveChatPage;
