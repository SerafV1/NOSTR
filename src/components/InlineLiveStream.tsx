import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NostrCore } from '../nostr/core';
import { LiveStreamInfo, decodeLiveNaddr, parseLiveEvent, posterSources, unplayableReason } from '../utils/liveStream';
import { usePosterTick } from '../hooks/usePosterTick';
import { streamEmbed } from '../utils/streamEmbed';
import { formatAddress } from '../utils/helpers';
import StreamSurface from './StreamSurface';
import { PlayIcon } from './Icons';

/**
 * Only one of these plays at a time. Without this a feed could end up with
 * two streams sounding at once and two docked players stacked in the same
 * corner — starting one stops whichever was already going.
 */
let stopPlayingElsewhere: (() => void) | null = null;

interface InlineLiveStreamProps {
  /** The stream's address, however it was written in the note */
  naddr: string;
  /** The link it was written as, kept as the anchor's href */
  href?: string;
}

/**
 * A shared stream, shown as the stream rather than as its address.
 *
 * People share a stream by copying what is in the address bar, so a note
 * announcing one carries a link to a page — and a link is all it used to be
 * here, with no title, no picture and no way to tell whether the stream was
 * still running.
 *
 * The address names the event rather than a copy of it, so what is drawn is
 * whatever the stream says about itself right now: a stream that has since
 * ended says so, on a note written while it was live.
 */
const InlineLiveStream: React.FC<InlineLiveStreamProps> = ({ naddr, href }) => {
  // Navigating from here rather than through a prop: the card turns up inside
  // notes, replies and the chat, and every one of those is on a routed page
  const navigate = useNavigate();
  const [stream, setStream] = useState<LiveStreamInfo | null>(null);
  const [hostName, setHostName] = useState('');
  const [missing, setMissing] = useState(false);
  const [playing, setPlaying] = useState(false);
  // A note gives the stream about a third of the screen. Enlarging opens the
  // whole player at the size a stream is worth watching at — and for one that
  // is no longer running, the poster, which is all there is to enlarge.
  const [zoomed, setZoomed] = useState(false);
  // Scrolled past while playing, so the player has left the note and sits in
  // the corner instead
  const [docked, setDocked] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);
  // A running stream's poster is rewritten at the same address as it goes
  const posterAt = usePosterTick();
  const poster = stream ? posterSources(stream, posterAt)[0] : undefined;

  useEffect(() => {
    const address = decodeLiveNaddr(naddr);
    if (!address) { setMissing(true); return; }

    let cancelled = false;
    (async () => {
      // A card can be drawn before this browser has finished connecting to
      // any relay — on a phone that is the common case, not the rare one —
      // and one empty answer then stood as "no such stream" for good. So it
      // asks again a few times, waiting longer each time.
      for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1500));
          if (cancelled) return;
        }

        const event = await NostrCore.fetchEventByAddress(address.kind, address.pubkey, address.identifier);
        if (cancelled) return;
        if (!event) continue;

        const parsed = parseLiveEvent(event);
        setStream(parsed);

        const profiles = await NostrCore.fetchProfiles([parsed.hostPubkey]);
        if (cancelled) return;
        const profile = profiles.get(parsed.hostPubkey);
        setHostName(profile?.display_name || profile?.name || formatAddress(parsed.hostPubkey));
        return;
      }

      // Asked for often enough now that this means the relays this browser
      // uses genuinely do not hold it
      if (!cancelled) setMissing(true);
    })();

    return () => { cancelled = true; };
  }, [naddr]);

  // Follows the note's own place on the page: out of sight means the player
  // moves to the corner, back in sight means it returns. Two thresholds so a
  // player sitting exactly on the edge does not flicker between the two.
  useEffect(() => {
    const slot = slotRef.current;
    if (!playing || !slot) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio < 0.15) setDocked(true);
        else if (entry.intersectionRatio > 0.5) setDocked(false);
      },
      { threshold: [0, 0.15, 0.5, 1] }
    );
    observer.observe(slot);
    return () => observer.disconnect();
  }, [playing]);

  // A player left docked after its note is gone — a feed refresh, a page
  // change — would otherwise keep sounding from an empty corner
  useEffect(() => {
    if (!playing) return;
    stopPlayingElsewhere?.();
    const stop = () => { setPlaying(false); setDocked(false); };
    stopPlayingElsewhere = stop;
    return () => {
      if (stopPlayingElsewhere === stop) stopPlayingElsewhere = null;
    };
  }, [playing]);

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigate(`/live/${naddr}`);
  };

  if (missing) {
    // Relays may simply not have it; the link still leads somewhere
    return (
      <a
        className="mention-link"
        href={href || `/live/${naddr}`}
        onClick={(e) => e.stopPropagation()}
      >
        📺 View stream
      </a>
    );
  }

  if (!stream) {
    return <div className="inline-stream-card inline-stream-loading">Loading stream…</div>;
  }

  // Only a running stream with an address this browser can actually open gets
  // a play button; the rest is a card that leads to the page
  const playable = stream.status === 'live'
    && !!stream.streamingUrl
    // A twitch/kick/youtube address plays through that service's own player,
    // so the checks a playlist has to pass don't apply to it
    && (!!streamEmbed(stream.streamingUrl) || !unplayableReason(stream.streamingUrl));

  if (playing && playable) {
    return (
      // The slot holds the note's layout open while the player is away in the
      // corner — without it the feed jumps under the reader's cursor at the
      // moment they scroll past
      <div className="inline-stream-slot" ref={slotRef}>
        <div className={`inline-stream-playing ${docked ? 'docked' : ''}`}>
          {docked && (
            <div className="inline-stream-dock-bar">
              <button
                type="button"
                onClick={() => slotRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                title="Back to the post"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => { setPlaying(false); setDocked(false); }}
                title="Close the player"
              >
                ✕
              </button>
            </div>
          )}
          <StreamSurface src={stream.streamingUrl} className="inline-stream-video" />
        </div>
      </div>
    );
  }

  return (
    <div className="inline-stream-card" onClick={(e) => e.stopPropagation()}>
      <div
        className="inline-stream-art"
        style={poster ? { backgroundImage: `url(${poster})` } : undefined}
      >
        {playable && (
          <button
            type="button"
            className="inline-stream-art-play"
            onClick={(e) => { e.stopPropagation(); setPlaying(true); }}
            title="Play the stream here"
          >
            <PlayIcon />
          </button>
        )}
        <span className={`inline-stream-status inline-stream-status-${stream.status}`}>
          {stream.status === 'live' ? 'LIVE' : stream.status === 'planned' ? 'PLANNED' : 'ENDED'}
        </span>
        {stream.status === 'live' && stream.currentParticipants !== undefined && (
          <span className="inline-stream-viewers">👁 {stream.currentParticipants.toLocaleString()}</span>
        )}
        {(playable || poster) && (
          <button
            type="button"
            className="inline-stream-zoom"
            onClick={(e) => { e.stopPropagation(); setZoomed(true); }}
            title={playable ? 'Watch it large' : 'Enlarge the picture'}
          >
            ⤢
          </button>
        )}
      </div>

      {zoomed && (
        // The same overlay a picture in a note opens into, so enlarging works
        // the one way everywhere — with the player in it where there is one
        <div className="image-modal" onClick={() => setZoomed(false)}>
          <div className="image-modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="image-modal-close" onClick={() => setZoomed(false)}>✕</button>
            {playable ? (
              <div className="inline-stream-large">
                <StreamSurface src={stream.streamingUrl} className="inline-stream-video" />
              </div>
            ) : (
              <img src={poster} alt={stream.title} className="image-modal-img"  loading="lazy" decoding="async" />
            )}
          </div>
        </div>
      )}

      <div className="inline-stream-meta">
        <a
          className="inline-stream-title"
          href={href || `/live/${naddr}`}
          onClick={open}
        >
          {stream.title}
        </a>
        {hostName && <span className="inline-stream-by">{hostName}</span>}
      </div>
    </div>
  );
};

export default InlineLiveStream;
