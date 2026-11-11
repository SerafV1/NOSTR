import { sizedImage } from './images';

/**
 * Every picture on the page, at the size it is drawn, and let go of while it
 * is far away.
 *
 * There are two dozen places in this app that render an `<img>`, and a
 * browser keeps each one decoded at the size it was uploaded — measured on a
 * home feed paged back three times: 685 pictures, 508 of them at whatever
 * size their author chose, including avatars of 2667x2667 and photographs of
 * 2700x2700. Over a long session that is a gigabyte of memory nobody can
 * see. Converting the call sites one by one covers the ones anybody thought
 * of; this covers the rest, and whatever gets written next.
 *
 * What it does to a picture:
 *
 *   - asks for it at twice the box it is actually drawn in, which is measured
 *     from the page rather than guessed
 *   - puts the address the page named back if that fails, so a resizer having
 *     a bad day costs nothing
 *   - while it sits more than a screen and a half away, holds its place and
 *     lets the picture go, and brings it back on approach
 *
 * What it leaves alone: anything already asked for at a size (the places
 * that do this for themselves, which have the advantage of knowing the size
 * before the request goes out), data and blob addresses, animations, vector
 * art, and anything marked `data-keep-full`.
 */

/** About a screen and a half: scrolling never sees a picture go or return */
const KEEP_WITHIN = '1200px 0px';

/** 1x1, transparent */
const NOTHING = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Below this there is nothing worth saving, and flicker to pay for it */
const WORTH_RELEASING_PX = 120;

/**
 * A video that has been played keeps what it has buffered for as long as the
 * element is in the page, and a feed is full of them: scroll past ten videos
 * you pressed play on and the memory is theirs, not the page's. So one that is
 * far away is paused and asked to let go, and takes its address back on
 * approach.
 *
 * Not the live player: its picture comes from a MediaSource that hls.js is
 * feeding, and taking that away does not pause a stream, it breaks it.
 */
const videoToRelease = (video: HTMLVideoElement): boolean => {
  const src = video.getAttribute('src') || '';
  return /^https?:\/\//i.test(src) && video.dataset.keepFull === undefined;
};

const touched = new WeakSet<HTMLImageElement>();

const skip = (img: HTMLImageElement): boolean => {
  if (img.dataset.keepFull !== undefined) return true;
  const src = img.getAttribute('src') || '';
  if (!/^https?:\/\//i.test(src)) return true;
  if (/wsrv\.nl\//i.test(src)) return true;
  if (/\.(gif|svg)(\?|#|$)/i.test(src)) return true;
  return false;
};

/**
 * A measurement below this is not a box, it is an element the page has not
 * laid out yet: an `<img>` with nothing in it and no width of its own
 * measures a pixel or two, and asking for a picture that size bakes a smudge
 * into the request for good. Measured on the composer's preview, which is
 * inserted empty and sized by the picture that arrives: it was asked for at
 * three pixels by four and drawn at 550 by 240.
 */
const TOO_SMALL_TO_BE_A_BOX = 32;

/**
 * The box this is drawn in. Its own, where it has been laid out; otherwise
 * what its parent allows, since a picture that has not loaded yet has no
 * size of its own to measure.
 */
const boxOf = (img: HTMLImageElement): { width: number; height?: number } => {
  const rect = img.getBoundingClientRect();
  const style = getComputedStyle(img);
  /**
   * Only a length in pixels says anything about the box. `max-width: 100%`
   * was being read as a hundred of them, which is how a picture across the
   * whole width of a card could be asked for at a hundred pixels wide.
   */
  const capped = (value: string): number | undefined => {
    if (!/^[\d.]+px$/.test((value || '').trim())) return undefined;
    const px = parseFloat(value);
    return Number.isFinite(px) && px > 0 ? px : undefined;
  };

  const own = Math.round(rect.width);
  const width = (own >= TOO_SMALL_TO_BE_A_BOX ? own : 0)
    || capped(style.maxWidth)
    || Math.round(img.parentElement?.getBoundingClientRect().width || 0)
    || 700;
  const ownHeight = Math.round(rect.height);
  const height = (ownHeight >= TOO_SMALL_TO_BE_A_BOX ? ownHeight : 0) || capped(style.maxHeight);
  return { width: Math.min(width, 1200), height: height ? Math.min(height, 1200) : undefined };
};

/** Waiting for the page to lay it out, so it is not measured twice over */
const settling = new WeakSet<HTMLImageElement>();

/** How many frames to wait for a box before giving up and guessing */
const FRAMES_TO_SETTLE = 3;

const size = (img: HTMLImageElement, frame: number = 0): void => {
  if (touched.has(img) || skip(img)) return;

  // Measured the instant it is added to the page, before anything has been
  // laid out, a picture has no box worth reading. One frame later it does.
  if (Math.round(img.getBoundingClientRect().width) < TOO_SMALL_TO_BE_A_BOX && frame < FRAMES_TO_SETTLE) {
    if (settling.has(img) && frame === 0) return;
    settling.add(img);
    requestAnimationFrame(() => size(img, frame + 1));
    return;
  }

  touched.add(img);

  const original = img.getAttribute('src') || '';
  const { width, height } = boxOf(img);
  // A cover-fitted picture is cropped by CSS anyway, so ask for it cropped;
  // everything else keeps all of itself
  const crop = getComputedStyle(img).objectFit === 'cover';
  const smaller = sizedImage(original, { width, height, crop });
  if (!smaller || smaller === original) return;

  img.dataset.original = original;
  img.addEventListener('error', () => {
    if (img.dataset.original && img.src !== img.dataset.original) {
      img.src = img.dataset.original;
    }
  }, { once: true });
  img.src = smaller;
};

const release = (observer: IntersectionObserver, img: HTMLImageElement): void => {
  const rect = img.getBoundingClientRect();
  if (rect.width < WORTH_RELEASING_PX && rect.height < WORTH_RELEASING_PX) return;
  observer.observe(img);
};

/**
 * Installed once, for the life of the page. Nothing here is undone: there is
 * no moment in this app where the pictures should go back to being asked for
 * whole.
 */
export function watchPictures(): void {
  if (typeof MutationObserver === 'undefined' || typeof IntersectionObserver === 'undefined') return;

  const away = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLVideoElement) {
        const video = entry.target;
        if (entry.isIntersecting) {
          const held = video.dataset.held;
          if (held) {
            delete video.dataset.held;
            video.src = held;
          }
          continue;
        }
        if (video.dataset.held || !videoToRelease(video)) continue;
        // Paused first: a video asked to drop its source mid-play reports an
        // error, and the card would show the failure of something nobody was
        // watching
        video.pause();
        video.dataset.held = video.src;
        video.removeAttribute('src');
        video.load();
        continue;
      }

      const img = entry.target as HTMLImageElement;
      if (entry.isIntersecting) {
        const held = img.dataset.held;
        if (held) {
          delete img.dataset.held;
          img.style.removeProperty('width');
          img.style.removeProperty('height');
          img.src = held;
        }
        continue;
      }
      if (img.dataset.held) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < WORTH_RELEASING_PX && rect.height < WORTH_RELEASING_PX) continue;
      // Its own space, kept, so nothing below it moves while it is gone
      img.style.width = `${Math.round(rect.width)}px`;
      img.style.height = `${Math.round(rect.height)}px`;
      img.dataset.held = img.src;
      img.src = NOTHING;
    }
  }, { rootMargin: KEEP_WITHIN });

  const look = (root: ParentNode) => {
    const images = root instanceof HTMLImageElement
      ? [root]
      : Array.from(root.querySelectorAll?.('img') || []);
    for (const img of images) {
      size(img);
      release(away, img);
    }

    const videos = root instanceof HTMLVideoElement
      ? [root]
      : Array.from(root.querySelectorAll?.('video') || []);
    for (const video of videos) {
      if (videoToRelease(video)) away.observe(video);
    }
  };

  look(document.body);

  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) look(node as Element);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
