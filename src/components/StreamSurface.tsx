import React, { useMemo } from 'react';
import LiveVideoPlayer from './LiveVideoPlayer';
import MediaEmbed from './MediaEmbed';
import { streamEmbed } from '../utils/streamEmbed';

interface StreamSurfaceProps {
  src: string;
  className?: string;
  /** Given only where the picture can be sent to a corner of the page */
  onMinimize?: () => void;
  minimized?: boolean;
  /** Start playing on its own — for a stream the viewer has just opened */
  autoplay?: boolean;
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
}) => {
  const embed = useMemo(() => streamEmbed(src, autoplay), [src, autoplay]);

  if (!embed) {
    return (
      <LiveVideoPlayer
        src={src}
        className={className}
        onMinimize={onMinimize}
        minimized={minimized}
      />
    );
  }

  return (
    <div className={`stream-embed ${className}`}>
      <MediaEmbed embed={embed} className="stream-embed-frame" />
      <div className="stream-embed-marks">
        <span className="stream-embed-live">LIVE</span>
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
