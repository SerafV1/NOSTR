import React, { useMemo, useState } from 'react';
import LiveVideoPlayer from './LiveVideoPlayer';
import MediaEmbed from './MediaEmbed';
import { streamEmbed } from '../utils/streamEmbed';
import { streamRoom } from '../utils/liveStream';

interface StreamSurfaceProps {
  src: string;
  className?: string;
  /** Given only where the picture can be sent to a corner of the page */
  onMinimize?: () => void;
  minimized?: boolean;
  /** Start playing on its own — for a stream the viewer has just opened */
  autoplay?: boolean;
  /**
   * Whether this is the stream being listened to. Given only where a page
   * shows more than one at a time; left out, each player keeps its own
   * mute button and nothing overrules it.
   */
  sound?: boolean;
  /** Someone pressed unmute here — the page decides what to do about it */
  onWantSound?: () => void;
  /** The room's own page, where the event names one (NIP-53 `service`) */
  service?: string;
  /** NIP-32 labels from the event, which is how an audio space says so */
  labels?: string[];
}

/**
 * One stream, played whichever way its address allows: a playlist goes to our
 * own player, a Twitch/Kick/YouTube page goes to that service's player. The
 * two look the same from outside, so the pages around them don't have to know
 * which kind of stream they are showing.
 */
const StreamSurface: React.FC<StreamSurfaceProps> = ({
  src,
  className = '',
  onMinimize,
  minimized,
  autoplay = true,
  sound,
  onWantSound,
  service,
  labels,
}) => {
  const embed = useMemo(() => streamEmbed(src, autoplay, sound === true), [src, autoplay, sound]);
  const room = useMemo(
    () => streamRoom({ streamingUrl: src, service, labels }),
    [src, service, labels]
  );
  const [joined, setJoined] = useState(false);

  // A room is not a broadcast: there is no video at that address, only the
  // page the talking happens on. Handing it to a video player fetched an
  // HTML document and reported that the stream could not be played, while
  // the chat beside it filled with people in the room.
  if (room) {
    // Only when asked. The room's own page wants a microphone, and a page
    // that opens on its own and asks for one is a page nobody trusts —
    // pressing Join is the moment that becomes reasonable.
    if (joined && room.embeddable) {
      return (
        <div className={`stream-room-frame ${className}`}>
          <iframe
            src={room.url}
            title={`Audio space at ${room.host}`}
            allow="microphone; autoplay; clipboard-write"
            referrerPolicy="no-referrer"
          />
        </div>
      );
    }

    return (
      <div className={`stream-room ${className}`}>
        <span className="stream-room-mark" aria-hidden="true">🎙</span>
        <p className="stream-room-say">This is an audio space, not a video stream.</p>
        <div className="stream-room-ways">
          {room.embeddable && (
            <button
              type="button"
              className="btn btn-primary btn-with-icon"
              onClick={() => setJoined(true)}
            >
              🎙 Join here
            </button>
          )}
          <a
            className={`btn ${room.embeddable ? 'btn-secondary' : 'btn-primary'} btn-with-icon`}
            href={room.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open at {room.host} ↗
          </a>
        </div>
        <p className="stream-room-note">
          {room.embeddable
            ? 'Joining here opens the room in this page, and it will ask for your microphone. The chat below is this room\'s either way.'
            : `${room.host} does not allow itself to be opened inside another page, so joining happens there. The chat below is this room's.`}
        </p>
      </div>
    );
  }

  if (!embed) {
    return (
      <LiveVideoPlayer
        src={src}
        className={className}
        onMinimize={onMinimize}
        minimized={minimized}
        sound={sound}
        onWantSound={onWantSound}
      />
    );
  }

  return (
    <div className={`stream-embed ${className}`}>
      <MediaEmbed embed={embed} className="stream-embed-frame" />
      <div className="stream-embed-marks">
        <span className="stream-embed-live">LIVE</span>
        {/* Another service's player cannot be reached into from here, so
            this is the only way to offer the sound on one of those */}
        {onWantSound && !sound && (
          <button
            type="button"
            className="stream-embed-minimize"
            onClick={onWantSound}
            title="Listen to this one"
          >
            🔈
          </button>
        )}
        {onMinimize && (
          <button
            type="button"
            className="stream-embed-minimize"
            onClick={onMinimize}
            title={minimized ? 'Back to full size' : 'Send it to the corner'}
          >
            {minimized ? '⤢' : '⤡'}
          </button>
        )}
      </div>
    </div>
  );
};

export default StreamSurface;
