import React, { useState } from 'react';
import LiveVideoPlayer from './LiveVideoPlayer';
import { PlayIcon } from './Icons';

interface InlineStreamPlayerProps {
  src: string;
  className?: string;
}

/**
 * A live stream posted as a plain link, played where it was posted.
 *
 * An HLS playlist is not a file the browser can open the way an .mp4 is —
 * outside Safari it needs hls.js — so a stream link used to sit in a note as
 * text, and the one thing worth seeing took a trip to another tab.
 *
 * It waits for a press rather than starting on its own: a live stream has no
 * end to buffer towards, so a feed that autoplayed every one of them would
 * pull several streams at once for as long as the page stayed open. The
 * player underneath does start immediately once mounted, which is what
 * pressing play is asking for.
 */
const InlineStreamPlayer: React.FC<InlineStreamPlayerProps> = ({ src, className }) => {
  const [playing, setPlaying] = useState(false);

  if (playing) return <LiveVideoPlayer src={src} className={className} />;

  let host = '';
  try {
    host = new URL(src).hostname.replace(/^www\./, '');
  } catch {
    // A malformed address still gets a play button; the player reports what
    // went wrong far better than a card refusing to draw
  }

  return (
    <button
      type="button"
      /* The caller's class styles the player, and carries a display of its
         own that would undo this plate's layout. The plate sets its own
         size, so it does not need it. */
      className="inline-stream-poster"
      onClick={(e) => { e.stopPropagation(); setPlaying(true); }}
    >
      <span className="inline-stream-play"><PlayIcon /></span>
      <span className="inline-stream-label">
        <span className="inline-stream-kind">Live stream</span>
        {host && <span className="inline-stream-host">{host}</span>}
      </span>
    </button>
  );
};

export default InlineStreamPlayer;
