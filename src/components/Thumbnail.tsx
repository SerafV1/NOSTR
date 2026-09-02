import React, { useState } from 'react';

interface ThumbnailProps {
  /**
   * Where the picture is. Several may be given, best first — a stream's own
   * poster, then the broadcaster's banner, then their face — and each is
   * tried in turn when the one before it fails.
   */
  src?: string | (string | undefined)[];
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
  const sources = (Array.isArray(src) ? src : [src]).filter((one): one is string => Boolean(one));
  const [tried, setTried] = useState(0);
  const showing = sources[tried];

  if (!showing) {
    return (
      <div className={`${fallbackClassName} ${className || ''}`.trim()} aria-label={alt || undefined}>
        <span className="thumbnail-fallback-mark" aria-hidden="true">{fallback}</span>
      </div>
    );
  }

  return (
    <img
      // Keyed on the address, so stepping to the next one is a new image
      // rather than a src swap the browser may not re-attempt
      key={showing}
      src={showing}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => setTried(at => at + 1)}
    />
  );
};

export default Thumbnail;
