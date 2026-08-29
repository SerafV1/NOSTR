import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserProfile } from '../types';
import { NostrCore } from '../nostr/core';
import { parseLiveEvent, LiveStreamInfo, liveEventAddress, decodeLiveNaddr } from '../utils/liveStream';
import { formatAddress } from '../utils/helpers';
import StreamSurface from './StreamSurface';
import LiveChatPanel from './LiveChatPanel';
import ZapButton from './ZapButton';
import EmojiText from './EmojiText';
import { ZapIcon } from './Icons';

interface LiveTogetherPageProps {
  /** The streams to watch at once, in the order the address named them */
  naddrs: string[];
  relaysConnected: boolean;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

interface Watched {
  naddr: string;
  info: LiveStreamInfo;
  profile: UserProfile | null;
}

/**
 * Two people playing the same game, each with a stream of their own, watched
 * side by side by a third.
 *
 * Nothing here is combined into one picture — that would take a server
 * pulling both feeds and re-encoding them. Two players on one page cost
 * nothing, and each stream stays exactly what its broadcaster published.
 *
 * The one thing a page like this must decide is who is heard: two streams
 * talking at once is worse than either alone, and the browser will not
 * autoplay sound anyway. So one tile carries it, chosen by a click, and the
 * chat follows whoever is being listened to.
 *
 * What it cannot do is line them up in time. Two independent broadcasts run
 * seconds apart — each has its own encoder and its own segment length — so
 * the same moment arrives here twice, at two different times. This is two
 * views of one game, not a split-screen recording of it.
 */
const LiveTogetherPage: React.FC<LiveTogetherPageProps> = ({
  naddrs,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic
}) => {
  const navigate = useNavigate();
  const [watched, setWatched] = useState<Watched[]>([]);
  const [loading, setLoading] = useState(true);
  /** Which of them is being listened to, by address */
  const [listeningTo, setListeningTo] = useState<string | null>(null);
  /** Whose chat is on screen — the listened-to stream's, until asked otherwise */
  const [chatFor, setChatFor] = useState<string | null>(null);
  /** When each copy on screen was published, so an older one cannot replace it */
  const latestAt = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;

    const read = async (naddr: string): Promise<Watched | null> => {
      const at = decodeLiveNaddr(naddr);
      if (!at) return null;
      const event = await NostrCore.fetchEventByAddress(at.kind, at.pubkey, at.identifier);
      if (!event) return null;
      if ((event.created_at || 0) < (latestAt.current.get(naddr) || 0)) return null;
      latestAt.current.set(naddr, event.created_at || 0);
      const info = parseLiveEvent(event);
      const profile = await NostrCore.fetchUserProfile(info.hostPubkey);
      return { naddr, info, profile };
    };

    const load = async () => {
      const found = (await Promise.all(naddrs.map(read))).filter((s): s is Watched => s !== null);
      if (cancelled || found.length === 0) return;
      setWatched(current => {
        // A refresh only replaces what it actually found, so a stream whose
        // relay was slow this time round does not blink out of the page
        const merged = new Map(current.map(s => [s.naddr, s]));
        for (const stream of found) merged.set(stream.naddr, stream);
        return naddrs.map(n => merged.get(n)).filter((s): s is Watched => s !== undefined);
      });
      setListeningTo(sounded => sounded ?? found[0].naddr);
      setLoading(false);
    };

    void load().finally(() => { if (!cancelled) setLoading(false); });

    // The live event is republished as the broadcast goes on — the status
    // ends with it, and the title changes with it
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30000);

    return () => { cancelled = true; clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naddrs.join(','), relaysConnected]);

  if (!relaysConnected || (loading && watched.length === 0)) {
    return (
      <div className="live-together-page">
        <div className="loading">{!relaysConnected ? 'Connecting to relays...' : 'Loading streams...'}</div>
      </div>
    );
  }

  if (watched.length === 0) {
    return (
      <div className="live-together-page">
        <div className="error">Neither stream could be found</div>
      </div>
    );
  }

  const nameOf = (stream: Watched) =>
    stream.profile?.display_name || stream.profile?.name || formatAddress(stream.info.hostPubkey);

  const chatting = watched.find(s => s.naddr === (chatFor || listeningTo)) || watched[0];
  const chatAddress = liveEventAddress(
    30311,
    chatting.info.pubkey,
    chatting.info.dTag
  );

  return (
    <div className="live-together-page">
      <div className="live-together-streams">
        {watched.map(stream => {
          const heard = stream.naddr === listeningTo;
          return (
            <div
              key={stream.naddr}
              className={`live-together-tile${heard ? ' listening' : ''}`}
            >
              <StreamSurface
                src={stream.info.streamingUrl}
                // The player wraps itself in a 16:9 box; this only sizes the picture inside it
                className="live-stream-video"
                sound={heard}
                onWantSound={() => setListeningTo(stream.naddr)}
              />

              <div className="live-together-tile-bar">
                <button
                  type="button"
                  className="live-together-tile-who"
                  onClick={() => onNavigateToProfile(stream.info.hostPubkey)}
                  title="Open this streamer"
                >
                  {stream.profile?.picture && (
                    <img src={stream.profile.picture} alt="" loading="lazy" decoding="async" />
                  )}
                  <EmojiText text={nameOf(stream)} emojis={stream.profile?.emojis} />
                </button>

                <span className="live-together-tile-title" title={stream.info.title}>
                  {stream.info.title}
                </span>

                {stream.info.status !== 'live' && (
                  <span className="live-together-tile-ended">
                    {stream.info.status === 'planned' ? 'Not started' : 'Ended'}
                  </span>
                )}

                {/* Sound is one at a time, so the button is on whoever is
                    silent — the tile being listened to has nothing to offer */}
                {!heard && (
                  <button
                    type="button"
                    className="live-together-listen"
                    onClick={() => setListeningTo(stream.naddr)}
                  >
                    🔈 Listen
                  </button>
                )}

                {stream.profile?.lud16 && (
                  <ZapButton
                    lud16={stream.profile.lud16}
                    triggerClassName="live-together-zap"
                    triggerTitle={`Zap ${nameOf(stream)}`}
                    recipientPubkey={stream.info.hostPubkey}
                    recipientName={nameOf(stream)}
                    recipientPicture={stream.profile?.picture}
                    recipientEmojis={stream.profile?.emojis}
                  >
                    <ZapIcon />
                  </ZapButton>
                )}

                {/* The way back to watching one stream: keep the one you
                    are on, drop the other. A mark on its own was there
                    before and read as "make it bigger" — the words are what
                    make it the way out. */}
                <button
                  type="button"
                  className="live-together-alone"
                  onClick={() => navigate(`/live/${stream.naddr}`)}
                  title="Leave the other stream and watch this one on its own"
                >
                  ⤢ Only this
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="live-together-chat">
        {/* One chat at a time rather than two columns nobody can read. It
            follows the stream being listened to; the tabs are for reading
            the other room without changing who is heard. */}
        <div className="live-together-chat-tabs">
          {watched.map(stream => (
            <button
              key={stream.naddr}
              type="button"
              className={stream.naddr === chatting.naddr ? 'active' : ''}
              onClick={() => setChatFor(stream.naddr)}
            >
              {nameOf(stream)}
            </button>
          ))}
        </div>

        <div className="live-chat-dock live-together-chat-dock">
        <LiveChatPanel
          // A different stream is a different room: start it clean rather
          // than letting one room's messages settle into the other's
          key={chatAddress}
          address={chatAddress}
          relaysConnected={relaysConnected}
          disabled={chatting.info.status !== 'live'}
          owners={[chatting.info.pubkey, chatting.info.hostPubkey]}
          identifier={chatting.info.dTag}
          onNavigateToProfile={onNavigateToProfile}
          onNavigateToNote={onNavigateToNote}
          onNavigateToTopic={onNavigateToTopic}
        />
        </div>
      </div>
    </div>
  );
};

export default LiveTogetherPage;
