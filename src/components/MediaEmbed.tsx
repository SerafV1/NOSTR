import React from 'react';
import { Embed } from '../utils/media';

interface MediaEmbedProps {
  embed: Embed;
  className?: string;
}

/**
 * Renders one third-party player (YouTube, Spotify, SoundCloud, …) as an
 * iframe. Video embeds get a responsive 16:9 box; audio widgets get the
 * fixed height their provider expects, since they don't scale by ratio.
 */
const MediaEmbed: React.FC<MediaEmbedProps> = ({ embed, className = '' }) => {
  const isVideo = embed.height === null;
  const classes = [isVideo ? 'event-video-embed' : 'event-audio-embed', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} style={isVideo ? undefined : { height: `${embed.height}px` }}>
      <iframe
        src={embed.src}
        title={embed.title}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
};

export default MediaEmbed;
