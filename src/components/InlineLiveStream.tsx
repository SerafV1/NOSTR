import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NostrCore } from '../nostr/core';
import { LiveStreamInfo, decodeLiveNaddr, parseLiveEvent, unplayableReason } from '../utils/liveStream';
import { formatAddress } from '../utils/helpers';
import LiveVideoPlayer from './LiveVideoPlayer';
import { PlayIcon } from './Icons';

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

  useEffect(() => {
    const address = decodeLiveNaddr(naddr);
    if (!address) { setMissing(true); return; }

    let cancelled = false;
    (async () => {
      const event = await NostrCore.fetchEventByAddress(address.kind, address.pubkey, address.identifier);
      if (cancelled) return;
      if (!event) { setMissing(true); return; }

      const parsed = parseLiveEvent(event);
      setStream(parsed);

      const profiles = await NostrCore.fetchProfiles([parsed.hostPubkey]);
      if (cancelled) return;
      const profile = profiles.get(parsed.hostPubkey);
      setHostName(profile?.display_name || profile?.name || formatAddress(parsed.hostPubkey));
    })();

    return () => { cancelled = true; };
  }, [naddr]);

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
    && !unplayableReason(stream.streamingUrl);

  if (playing && playable) {
    return <LiveVideoPlayer src={stream.streamingUrl} className="inline-stream-video" />;
  }

  return (
    <div className="inline-stream-card" onClick={(e) => e.stopPropagation()}>
      <div
        className="inline-stream-art"
        style={stream.image ? { backgroundImage: `url(${stream.image})` } : undefined}
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
        {(playable || stream.image) && (
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
                <LiveVideoPlayer src={stream.streamingUrl} className="inline-stream-video" />
              </div>
            ) : (
              <img src={stream.image} alt={stream.title} className="image-modal-img" />
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
