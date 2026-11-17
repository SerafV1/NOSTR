import React, { useEffect, useState } from 'react';
import LiveVideoPlayer from './LiveVideoPlayer';
import { PlayIcon } from './Icons';
import { somebodyPlaying, takeTurn, useStartWhenSeen } from '../utils/streamTurn';

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
 * It starts by itself, muted, once it is on screen and nothing else is
 * playing, and stops when scrolled past: a live stream has no end to buffer
 * towards, so a feed that played every one of them would pull several at
 * once for as long as the page stayed open.
 */
const InlineStreamPlayer: React.FC<InlineStreamPlayerProps> = ({ src, className }) => {
  const [playing, setPlaying] = useState(false);
  const [auto, setAuto] = useState(false);
  const [box, setBox] = useState<HTMLElement | null>(null);
  const seen = useStartWhenSeen(box, true);

  useEffect(() => {
    if (!playing) return;
    return takeTurn(() => { setPlaying(false); setAuto(false); });
  }, [playing]);

  useEffect(() => {
    if (seen && !playing && !somebodyPlaying()) {
      setAuto(true);
      setPlaying(true);
    } else if (!seen && playing && auto) {
      setPlaying(false);
      setAuto(false);
    }
  });

  if (playing) {
    return (
      <div className="inline-stream-auto" ref={setBox}>
        <LiveVideoPlayer src={src} className={className} />
      </div>
    );
  }

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
      ref={setBox}
      onClick={(e) => { e.stopPropagation(); setAuto(false); setPlaying(true); }}
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
