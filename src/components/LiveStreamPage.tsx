import React, { useEffect, useState } from 'react';
import { UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { parseLiveEvent, LiveStreamInfo, liveEventAddress, encodeLiveNaddr } from '../utils/liveStream';
import { formatAddress } from '../utils/helpers';
import LiveVideoPlayer from './LiveVideoPlayer';
import LiveChatPanel, { PresentPerson } from './LiveChatPanel';
import ZapButton from './ZapButton';
import RichText from './RichText';
import EmojiText from './EmojiText';
import { ZapIcon } from './Icons';

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
const VISIBLE_FACES = 8;

const LiveStreamPage: React.FC<LiveStreamPageProps> = ({ kind, pubkey, identifier, relaysConnected, onNavigateToProfile, onNavigateToNote, onNavigateToTopic }) => {
  // On a phone the chat sits below the video and the details, far from what
  // it is about. Opening it over the page keeps the stream in view while
  // reading along, the way stream sites do it.
  const [chatOpen, setChatOpen] = useState(false);
  const [present, setPresent] = useState<PresentPerson[]>([]);
  const [copied, setCopied] = useState<'watch' | 'chat' | null>(null);
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
        const parsed = parseLiveEvent(event);
        setStream(parsed);
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

    return () => { cancelled = true; };
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

  const copyLink = async (which: 'watch' | 'chat', url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Denied clipboard permission — show it instead of failing silently
      prompt('Copy this address:', url);
    }
  };

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

              {/* Addresses worth handing to someone else: the stream itself,
                  and the chat on its own for an OBS browser source. Copying
                  them here saves opening the chat window just to read one. */}
              <div className="live-stream-links">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  title="Copy the address of this stream"
                  onClick={() => copyLink('watch', `${window.location.origin}/live/${naddrParam}`)}
                >
                  {copied === 'watch' ? '✓ Copied' : '🔗 Watch link'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  title="Copy the chat on its own — paste into an OBS browser source"
                  onClick={() => copyLink('chat', `${window.location.origin}/live/${naddrParam}/chat?transparent=1`)}
                >
                  {copied === 'chat' ? '✓ Copied' : '💬 Chat link'}
                </button>
              </div>
            </div>

            {(stream.currentParticipants !== undefined || present.length > 0) && (
              <div className="live-stream-presence">
                {stream.currentParticipants !== undefined && (
                  <span className="live-stream-viewers-count">
                    👁 {stream.currentParticipants} watching
                  </span>
                )}

                {/* Nobody publishes a viewer list — a live event names only its
                    host — so these are the people talking in the chat, which is
                    the only presence a client can actually know about. */}
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
          <button
            type="button"
            className="live-chat-close"
            onClick={() => setChatOpen(false)}
            aria-label="Close chat"
          >
            ✕
          </button>

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
            onPeoplePresent={setPresent}
            disabled={stream.status !== 'live'}
            onNavigateToProfile={onNavigateToProfile}
            onNavigateToNote={onNavigateToNote}
            onNavigateToTopic={onNavigateToTopic}
          />
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
