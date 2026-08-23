import React, { useEffect, useRef, useState } from 'react';
import { UserProfile, EVENT_KINDS } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { parseLiveEvent, LiveStreamInfo, liveEventAddress, encodeLiveNaddr } from '../utils/liveStream';
import { formatAddress } from '../utils/helpers';
import LiveVideoPlayer from './LiveVideoPlayer';
import LiveChatPanel, { PresentPerson } from './LiveChatPanel';
import LiveZappersPanel from './LiveZappersPanel';
import ZapButton from './ZapButton';
import RichText from './RichText';
import EmojiText from './EmojiText';
import { ZapIcon, PopOutIcon } from './Icons';

interface LiveStreamPageProps {
  kind: number;
  pubkey: string;
  identifier: string;
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

/** Beyond this the row of faces starts crowding the line it sits on */

/** Faces shown before the rest fold into a "+N" */
const VISIBLE_FACES = 8;

const LiveStreamPage: React.FC<LiveStreamPageProps> = ({ kind, pubkey, identifier, relaysConnected, onNavigateToProfile, onNavigateToNote, onNavigateToTopic }) => {
  // On a phone the chat sits below the video and the details, far from what
  // it is about. Opening it over the page keeps the stream in view while
  // reading along, the way stream sites do it.
  const [chatOpen, setChatOpen] = useState(false);
  const [present, setPresent] = useState<PresentPerson[]>([]);
  /** How many zappers to list beside the stream, remembered between visits */
  const [topZappers, setTopZappers] = useState(() => {
    const held = Number(localStorage.getItem('razr_top_zappers'));
    return Number.isFinite(held) && held > 0 ? held : 10;
  });
  /** When the copy on screen was published, so an older one cannot replace it */
  const latestAt = useRef(0);
  const [stream, setStream] = useState<LiveStreamInfo | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    // On a hard refresh, relay connections start from scratch and take a
    // few seconds — fetching before they're up meant a genuinely live
    // stream would wrongly come back "not found" just because none of the
    // relays that actually have it had finished connecting yet.
    if (!relaysConnected) return;

    let cancelled = false;

    (async () => {
      // Coming from the Live list or the home sidebar, this event is
      // already in hand — draw the page from it now and let the refresh
      // below correct it. parseLiveEvent re-derives status from the
      // event's age, so a stream that has since ended shows as ended
      // rather than pretending to still be live.
      const known = EventCache.getAddressable(kind, pubkey, identifier);
      if (known) {
        const parsedKnown = parseLiveEvent(known);
        latestAt.current = known.created_at || 0;
        setStream(parsedKnown);
        setProfile(EventCache.getProfile(parsedKnown.hostPubkey));
        setLoading(false);
      } else {
        setLoading(true);
      }
      setNotFound(false);
      try {
        const event = await NostrCore.fetchEventByAddress(kind, pubkey, identifier);
        if (cancelled) return;
        if (!event) {
          // Only an outright miss with nothing on screen is "not found"
          if (!known) setNotFound(true);
          return;
        }
        // Recorded so an older copy still held by some relay cannot arrive
        // afterwards and replace what was just read — it would put an out of
        // date viewer count on screen and hold it there
        if ((event.created_at || 0) >= latestAt.current) {
          latestAt.current = event.created_at || 0;
          setStream(parseLiveEvent(event));
        }
        const parsed = parseLiveEvent(event);
        // The zap and the host line follow whoever is presenting, which on
        // a platform-published stream is not the account that signed the
        // event — that one has no Lightning address, so the zap button
        // silently never appeared
        const fetchedProfile = await NostrCore.fetchUserProfile(parsed.hostPubkey);
        if (!cancelled) setProfile(fetchedProfile);
      } catch (error) {
        console.error('Failed to load live stream:', error);
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // The event is republished as the stream goes on — the viewer count moves
    // with it, and so does the status when the broadcast ends. Fetched once
    // and never listened to, the page showed whatever the number happened to
    // be at the moment it was opened, for as long as it stayed open.
    const subId = NostrCore.subscribeLive(
      [{ kinds: [EVENT_KINDS.LIVE_EVENT], authors: [pubkey], '#d': [identifier] }],
      (event) => {
        if (cancelled) return;
        // The filter asks for one stream, but 18 of 81 broadcasters seen on
        // the relays run several — and a relay that ignores the 'd' filter
        // would otherwise hand this page another stream's viewer count
        if (event.pubkey !== pubkey) return;
        if (event.tags.find(t => t[0] === 'd')?.[1] !== identifier) return;

        setStream(current => {
          // Relays may still hold older copies of a replaceable event
          if (current && (event.created_at || 0) < (latestAt.current || 0)) return current;
          latestAt.current = event.created_at || 0;
          return parseLiveEvent(event);
        });
      }
    );

    // Under the subscription, for a relay that drops the socket or never
    // pushes the newer copy
    const poll = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const event = await NostrCore.fetchEventByAddress(kind, pubkey, identifier);
      if (!event || cancelled) return;
      if ((event.created_at || 0) <= (latestAt.current || 0)) return;
      latestAt.current = event.created_at || 0;
      setStream(parseLiveEvent(event));
    }, 30000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      NostrCore.unsubscribeLive(subId);
    };
  }, [kind, pubkey, identifier, relaysConnected]);

  if (loading || !relaysConnected) {
    return (
      <div className="live-stream-page">
        <div className="loading">{!relaysConnected ? 'Connecting to relays...' : 'Loading stream...'}</div>
      </div>
    );
  }

  if (notFound || !stream) {
    return (
      <div className="live-stream-page">
        <div className="error">Stream not found</div>
      </div>
    );
  }

  const hostName = profile?.display_name || profile?.name || formatAddress(stream.hostPubkey);


  const address = liveEventAddress(kind, stream.pubkey, stream.dTag);
  const naddrParam = encodeLiveNaddr(kind, stream.pubkey, stream.dTag);



  return (
    <div className="live-stream-page">
      <div className="live-stream-page-layout">
        <div className="live-stream-page-container">
          {stream.status === 'live' ? (
            <LiveVideoPlayer src={stream.streamingUrl} className="live-stream-video" />
          ) : (
            <div className="live-stream-offline">
              {stream.status === 'planned' ? '📅 This stream hasn\'t started yet' : '⏹ This stream has ended'}
            </div>
          )}

          <div className="live-stream-details">
            <div className="live-stream-details-header">
              <h1>{stream.title}</h1>
              {stream.status === 'live' && (
                <span className="live-stream-badge">LIVE</span>
              )}
            </div>

            <div className="live-stream-host-row">
              <button className="live-stream-host-link" onClick={() => onNavigateToProfile(stream.hostPubkey)}>
                {profile?.picture ? (
                  <img src={profile.picture} alt="" className="live-stream-host-avatar" />
                ) : (
                  <div className="live-stream-host-avatar-placeholder">{hostName.charAt(0).toUpperCase()}</div>
                )}
                <span><EmojiText text={hostName} emojis={profile?.emojis} /></span>
              </button>

              {/* Zapping the host is the usual way to tip a stream. Only
                  shown when they actually publish a Lightning address —
                  without one there is nothing to pay. */}
              {profile?.lud16 && (
                <ZapButton
                  lud16={profile.lud16}
                  recipientPubkey={stream.hostPubkey}
                  recipientName={hostName}
                  recipientEmojis={profile.emojis}
                  recipientPicture={profile.picture}
                  eventAddress={address}
                  triggerClassName="btn btn-secondary btn-small btn-with-icon"
                  triggerTitle={`Zap ${hostName}`}
                >
                  <ZapIcon /> Zap
                </ZapButton>
              )}

            </div>

            {(stream.currentParticipants !== undefined || present.length > 0) && (
              <div className="live-stream-presence">
                {stream.currentParticipants !== undefined && (
                  <span
                    className="live-stream-viewers-count"
                    title="The number the broadcaster's own software publishes — nostr has no other source for it"
                  >
                    👁 {stream.currentParticipants} viewers
                  </span>
                )}

                {/* Faces beside the count. Nobody publishes a viewer list —
                    a live event names only its host — so these are whoever
                    has spoken in the chat, which is the only presence a
                    client can know about; the row says so on hover. */}
                {present.length > 0 && (
                  <div className="live-stream-faces" title="Talking in the chat">
                    {present.slice(0, VISIBLE_FACES).map(person => (
                      <button
                        key={person.pubkey}
                        type="button"
                        className="live-stream-face"
                        title={person.name}
                        onClick={() => onNavigateToProfile(person.pubkey)}
                      >
                        {person.picture ? (
                          <img src={person.picture} alt={person.name} />
                        ) : (
                          <span className="live-stream-face-initial">
                            {person.name.charAt(0).toUpperCase()}
                          </span>
                        )}
                      </button>
                    ))}
                    {present.length > VISIBLE_FACES && (
                      <span className="live-stream-face-more">
                        +{present.length - VISIBLE_FACES}
                      </span>
                    )}
                  </div>
                )}

                {/* The count on its own, as a browser source for OBS */}
                {/* Opens the count on its own, where the background and
                    weight are chosen and the address for OBS is handed out */}
                <button
                  type="button"
                  className="live-stream-copy-link"
                  title="Open the viewer count on its own, to set up as an OBS browser source"
                  onClick={() => window.open(
                    `${window.location.origin}/live/${naddrParam}/viewers`,
                    `viewers-${naddrParam}`,
                    'width=420,height=320,menubar=no,toolbar=no'
                  )}
                >
                  <PopOutIcon />
                  Viewers link
                </button>
              </div>
            )}

            {stream.summary && (
              <p className="live-stream-summary">
                <RichText
                  content={stream.summary}
                  onNavigateToProfile={onNavigateToProfile}
                  onNavigateToNote={onNavigateToNote}
                  onNavigateToTopic={onNavigateToTopic}
                />
              </p>
            )}

            {stream.hashtags.length > 0 && (
              <div className="event-hashtags">
                {stream.hashtags.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    className="event-hashtag"
                    onClick={() => onNavigateToTopic?.(tag)}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={`live-chat-dock ${chatOpen ? 'open' : ''}`}>
          <LiveChatPanel
            address={address}
            // Desktop only: the chat as its own window, to keep beside the
            // video or on a second screen
            onPopOut={() => window.open(
              `${window.location.origin}/live/${naddrParam}/chat`,
              `chat-${naddrParam}`,
              'width=420,height=760,menubar=no,toolbar=no'
            )}
            relaysConnected={relaysConnected}
            disabled={stream.status !== 'live'}
            onPeoplePresent={setPresent}
            // Either account behind the stream may moderate it: on a
            // platform-published stream the presenter is not the signer
            owners={[stream.pubkey, stream.hostPubkey]}
            identifier={stream.dTag}
            onNavigateToProfile={onNavigateToProfile}
            onNavigateToNote={onNavigateToNote}
            onNavigateToTopic={onNavigateToTopic}
          />

          {/* Beside the chat, since it is the same zaps counted up rather
              than watched going past */}
          <LiveZappersPanel
            address={address}
            relaysConnected={relaysConnected}
            limit={topZappers}
            hideWhenEmpty
            onNavigateToProfile={onNavigateToProfile}
            headerAction={(<>
              <label className="live-zappers-count-label" title="How many zappers to list">
                <select
                  className="live-zappers-count"
                  value={topZappers}
                  onChange={(e) => {
                    const chosen = Number(e.target.value);
                    setTopZappers(chosen);
                    localStorage.setItem('razr_top_zappers', String(chosen));
                  }}
                >
                  {[5, 10, 20, 40, 80].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className="live-chat-obs-btn"
                title="Open the zappers on their own, to set up as an OBS browser source"
                onClick={() => window.open(
                  `${window.location.origin}/live/${naddrParam}/zappers`,
                  `zappers-${naddrParam}`,
                  'width=380,height=520,menubar=no,toolbar=no'
                )}
              >
                <PopOutIcon />
              </button>
            </>)}
          />

          <button
            type="button"
            className="live-chat-close"
            onClick={() => setChatOpen(false)}
            aria-label="Close chat"
          >
            ✕
          </button>
        </div>

        {/* Only on phones, where the dock is off-screen until asked for */}
        <button
          type="button"
          className="live-chat-fab"
          onClick={() => setChatOpen(open => !open)}
        >
          💬 {chatOpen ? 'Hide chat' : 'Chat'}
        </button>
      </div>
    </div>
  );
};

export default LiveStreamPage;
