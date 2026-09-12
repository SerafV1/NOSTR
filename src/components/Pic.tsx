import React, { useEffect, useRef, useState } from 'react';
import { sizedImage, PictureSize } from '../utils/images';

interface PicProps extends PictureSize {
  src?: string;
  alt?: string;
  className?: string;
  title?: string;
  /**
   * Let go of the picture while it is far from the screen.
   *
   * For the large ones — a photograph in a note — not for faces: a decoded
   * avatar is a few tens of kilobytes, and a list of them flickering as it
   * scrolls would cost more than it saves.
   */
  release?: boolean;
  /** Called when neither the resized picture nor the original could be shown */
  onGone?: () => void;
}

/** 1x1, transparent: the element stays, the picture does not */
const NOTHING = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** About a screen and a half either way — scrolling never sees this happen */
const KEEP_WITHIN = '1200px 0px';

/**
 * A picture asked for at the size it is drawn, with the original behind it.
 *
 * Resizing happens at somebody else's server, which can be busy, can refuse,
 * or can be blocked where the reader is. So a failure steps to the address
 * the note actually named, and only a failure of that counts as no picture.
 *
 * A browser keeps every picture on the page decoded in memory, whether it is
 * on screen or a hundred thousand pixels above it — measured on a feed paged
 * back eight times: 1,429 pictures held at once. Where asked, this lets the
 * far ones go and keeps the space they occupied, so nothing moves under the
 * reader when they come back.
 */
const Pic: React.FC<PicProps> = ({
  src, alt = '', className, title, width, height, crop, release, onGone
}) => {
  const [original, setOriginal] = useState(false);
  const [away, setAway] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  const box = useRef<{ width: number; height: number } | null>(null);

  const sized = sizedImage(src, { width, height, crop });
  const showing = original ? src : (sized || src);

  useEffect(() => {
    const img = ref.current;
    if (!release || !img || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setAway(false);
          return;
        }
        // Whatever it measured before going, so the page keeps its shape
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) box.current = { width: rect.width, height: rect.height };
        setAway(true);
      },
      { rootMargin: KEEP_WITHIN }
    );
    observer.observe(img);
    return () => observer.disconnect();
  }, [release, showing]);

  if (!showing) return null;

  const held = away && box.current
    ? { width: `${box.current.width}px`, height: `${box.current.height}px` }
    : undefined;

  return (
    <img
      ref={ref}
      // Keyed on which address is being tried, so stepping to the original is
      // a new request rather than a swap the browser may not re-attempt
      key={original ? 'original' : 'sized'}
      src={away ? NOTHING : showing}
      alt={alt}
      className={className}
      title={title}
      style={held}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (away) return;
        if (!original && sized && sized !== src) setOriginal(true);
        else onGone?.();
      }}
    />
  );
};

export default Pic;
