import React, { useState } from 'react';

interface ThumbnailProps {
  /** Where the picture is, if there is one */
  src?: string;
  alt?: string;
  className?: string;
  /** What to draw instead: a word, an emoji, whatever fits the frame */
  fallback?: React.ReactNode;
  /** The class the stand-in gets, so each place can size its own */
  fallbackClassName?: string;
}

/**
 * A poster that might not be there.
 *
 * A stream names its own picture and a video player derives one from the
 * address, and either can be a dead link — a host that has gone, a YouTube
 * thumbnail that was never generated, a file taken down. The browser draws
 * that as a broken image: an icon, the alt text, and a hole where the poster
 * should be, which in a grid of them looks like the page failed rather than
 * the picture.
 *
 * So a picture that does not arrive is replaced by a plate that fills the
 * same frame. Nothing is retried: an address that answered with an error
 * once will answer with it again, and the plate is the honest version of
 * what is known.
 */
const Thumbnail: React.FC<ThumbnailProps> = ({
  src,
  alt = '',
  className,
  fallback = '🎬',
  fallbackClassName = 'thumbnail-fallback'
}) => {
  const [broken, setBroken] = useState(false);

  if (!src || broken) {
    return (
      <div className={`${fallbackClassName} ${className || ''}`.trim()} aria-label={alt || undefined}>
        <span className="thumbnail-fallback-mark" aria-hidden="true">{fallback}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
};

export default Thumbnail;
