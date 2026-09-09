import React, { useEffect, useRef, useState } from 'react';
import { Embed } from '../utils/media';
import Thumbnail from './Thumbnail';

interface MediaEmbedProps {
  embed: Embed;
  className?: string;
}

/**
 * Whether this is on screen, with room between the two answers so a card
 * sitting on the edge does not flicker between them.
 */
function useOnScreen(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(!enabled);

  useEffect(() => {
    if (!enabled) return;
    const box = ref.current;
    if (!box || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio > 0.5) setShown(true);
        else if (entry.intersectionRatio < 0.15) setShown(false);
      },
      { threshold: [0, 0.15, 0.5, 1] }
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [enabled]);

  return { ref, shown };
}

/**
 * Renders one third-party player (YouTube, Spotify, SoundCloud, …) as an
 * iframe. Video embeds get a responsive 16:9 box; audio widgets get the
 * fixed height their provider expects, since they don't scale by ratio.
 *
 * A player that keeps going after it has been scrolled past — a reel, which
 * answers nothing said to it from outside — is taken out of the page while
 * it is not being looked at, and its poster holds the space until it is.
 */
const MediaEmbed: React.FC<MediaEmbedProps> = ({ embed, className = '' }) => {
  const isVideo = embed.height === null;
  // Named by service as well as by shape: a card that is neither video nor
  // an audio widget — an Instagram post, say — needs a width of its own
  const classes = [
    isVideo ? 'event-video-embed' : 'event-audio-embed',
    `media-embed-${embed.kind}`,
    className
  ]
    .filter(Boolean)
    .join(' ');

  const { ref, shown } = useOnScreen(!!embed.unloadOffscreen);

  return (
    <div
      ref={ref}
      className={classes}
      style={isVideo ? undefined : { height: `${embed.height}px` }}
    >
      {shown ? (
        <iframe
          src={embed.src}
          title={embed.title}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <div className="media-embed-resting">
          <Thumbnail
            src={embed.thumbnail}
            alt={embed.title}
            className="media-embed-resting-picture"
            fallback={`▶ ${embed.title}`}
            fallbackClassName="media-embed-resting-plate"
          />
        </div>
      )}
    </div>
  );
};

export default MediaEmbed;
