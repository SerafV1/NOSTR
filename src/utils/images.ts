/**
 * Pictures at the size they are shown, not the size they were uploaded.
 *
 * A browser keeps a decoded bitmap for every picture on the page, and the
 * size of that bitmap is the image's own dimensions — not the size it is
 * drawn at. Measured on a home feed of thirty-six posts: 345MB of decoded
 * pictures, including avatars published at 2667x2667 (28MB of memory each,
 * for a circle forty pixels wide) and two photographs at 3072x4080 (50MB
 * each). Eight pages of scrolling back took it past a thousand pictures.
 *
 * Nothing about the page can change what people upload, so the pictures are
 * asked for at a size worth keeping. weserv is a free resizing proxy —
 * measured on one of those avatars: 270KB of JPEG became 2KB of WebP at
 * 96x96, in half a second — and where it cannot help, the original address
 * is used instead, which is what `Pic` falls back to.
 *
 * It is also one fewer thing the original host learns: the picture is
 * fetched by the proxy, so the reader's address does not reach whoever is
 * hosting it.
 */

const RESIZER = 'https://wsrv.nl/';

/** An address this can do nothing with, or should not touch */
const untouchable = (url: string): boolean =>
  !/^https?:\/\//i.test(url)
  // Already going through the resizer
  || /(^|\.)wsrv\.nl\//i.test(url)
  // An animated picture resized is a still one, and the joke is the movement
  || /\.gif(\?|#|$)/i.test(url)
  // Vector art has no decoded size worth saving
  || /\.svg(\?|#|$)/i.test(url);

export interface PictureSize {
  /** The widest this will ever be drawn, in CSS pixels */
  width: number;
  /**
   * The tallest it will ever be drawn. Worth giving wherever the box has a
   * ceiling, which most of them do: a portrait photograph asked for by width
   * alone comes back twice as tall as it is wide, and the memory is the two
   * multiplied. A card's pictures stop at 620px, a picture in a line of text
   * at 180.
   */
  height?: number;
  /**
   * Whether the picture fills the box and is cropped to it — which is what a
   * face in a circle wants — or is fitted inside it whole, which is what a
   * photograph in a note wants.
   */
  crop?: boolean;
}

/**
 * The same picture, asked for at a size that suits where it is going. Twice
 * the box it is drawn in, so it still looks right on a dense screen.
 */
export function sizedImage(url: string | undefined, size: PictureSize): string | undefined {
  if (!url || untouchable(url)) return url;

  const width = Math.round(size.width * 2);
  const height = size.height ? Math.round(size.height * 2) : undefined;

  const query = new URLSearchParams({ url, w: String(width), output: 'webp', q: '82' });
  if (height) {
    query.set('h', String(height));
    // A face fills its circle; a photograph keeps all of itself and fits
    // inside what it is given
    query.set('fit', size.crop === false ? 'inside' : 'cover');
  }
  // Never larger than it came: a small picture blown up costs more memory
  // than it came with and looks worse doing it
  query.set('we', '');

  return `${RESIZER}?${query.toString()}`;
}
