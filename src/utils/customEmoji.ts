// NIP-30: an event may write an emoji as `:shortcode:` and name its picture
// in an `emoji` tag on the same event — ["emoji", "ggstr", "https://…"].
// Without reading those tags the text reads ":ggstr:", which is what people
// see in clients that skip this.

export type CustomEmojiMap = Record<string, string>;

/** The shortcode → picture mapping an event carries */
export function customEmojiMap(tags?: string[][]): CustomEmojiMap {
  const map: CustomEmojiMap = {};
  for (const tag of tags || []) {
    if (tag[0] === 'emoji' && tag[1] && tag[2]) map[tag[1]] = tag[2];
  }
  return map;
}

export interface EmojiPiece {
  type: 'text' | 'emoji';
  value: string;
  /** Set on 'emoji' pieces: where to load the picture from */
  url?: string;
}

const SHORTCODE = /:([a-zA-Z0-9_+-]+):/g;

/**
 * Split text so the shortcodes the map knows about can be drawn as pictures.
 * Unknown shortcodes stay as text — plenty of writing contains a colon pair
 * that was never meant as an emoji.
 */
export function splitCustomEmoji(text: string, map: CustomEmojiMap): EmojiPiece[] {
  if (!text || Object.keys(map).length === 0) return [{ type: 'text', value: text }];

  const pieces: EmojiPiece[] = [];
  const regex = new RegExp(SHORTCODE);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const url = map[match[1]];
    if (!url) continue;
    if (match.index > lastIndex) {
      pieces.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    pieces.push({ type: 'emoji', value: match[1], url });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) pieces.push({ type: 'text', value: text.slice(lastIndex) });
  return pieces;
}

/** True when the text has a shortcode this map can draw */
export function hasCustomEmoji(text: string, map: CustomEmojiMap): boolean {
  return splitCustomEmoji(text, map).some(piece => piece.type === 'emoji');
}
