// Shared helpers for detecting and stripping media URLs in note content

const IMAGE_URL_SOURCE = 'https?:\\/\\/[^\\s]+\\.(?:jpg|jpeg|png|gif|webp|bmp|svg)(?:\\?[^\\s]*)?';
const VIDEO_URL_SOURCE = 'https?:\\/\\/[^\\s]+\\.(?:mp4|webm|mov|m4v|ogv)(?:\\?[^\\s]*)?';
const YOUTUBE_URL_SOURCE =
  'https?:\\/\\/(?:www\\.|m\\.)?(?:youtube\\.com\\/(?:watch\\?v=|shorts\\/|live\\/|embed\\/)|youtu\\.be\\/)([A-Za-z0-9_-]{11})[^\\s]*';
const ANY_URL_SOURCE = 'https?:\\/\\/[^\\s]+';
// A quoted note reference (NIP-19 note/nevent) — rendered as an embedded
// quote card, so the raw nostr: URI is hidden from the visible text
const QUOTE_REF_SOURCE = 'nostr:(?:note1|nevent1)[a-z0-9]+';

const trimTrailingPunctuation = (url: string): string => url.replace(/[.,;:!?)]+$/, '');

export function extractImageUrls(content: string): string[] {
  const urls = new Set<string>();
  const matches = content.match(new RegExp(IMAGE_URL_SOURCE, 'gi')) || [];
  matches.forEach(url => urls.add(trimTrailingPunctuation(url)));
  return Array.from(urls);
}

export function extractVideoUrls(content: string): string[] {
  const urls = new Set<string>();
  const matches = content.match(new RegExp(VIDEO_URL_SOURCE, 'gi')) || [];
  matches.forEach(url => urls.add(trimTrailingPunctuation(url)));
  return Array.from(urls);
}

export function extractYouTubeIds(content: string): string[] {
  const ids = new Set<string>();
  const regex = new RegExp(YOUTUBE_URL_SOURCE, 'gi');
  let match;
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

/**
 * Media URLs get rendered as previews, so drop them from the visible text
 */
export function stripMediaUrls(content: string): string {
  let cleaned = content;
  for (const source of [IMAGE_URL_SOURCE, VIDEO_URL_SOURCE, YOUTUBE_URL_SOURCE, QUOTE_REF_SOURCE]) {
    cleaned = cleaned.replace(new RegExp(source, 'gi'), '');
  }
  return cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface LinkifiedPart {
  type: 'text' | 'link';
  value: string;
}

/**
 * Split text into plain-text and URL parts so URLs can render as anchors
 */
export function splitTextAndLinks(text: string): LinkifiedPart[] {
  return splitContentTokens(text).map((token): LinkifiedPart =>
    token.type === 'link' ? { type: 'link', value: token.value } : { type: 'text', value: token.value }
  );
}

export interface ContentToken {
  type: 'text' | 'link' | 'hashtag';
  /** For 'hashtag' tokens this is the tag without the leading '#' */
  value: string;
}

const HASHTAG_SOURCE = '#[\\p{L}\\p{N}_]+';
const TOKEN_REGEX = new RegExp(`(${ANY_URL_SOURCE})|(${HASHTAG_SOURCE})`, 'giu');

/**
 * Split text into plain-text, URL and #hashtag parts so both can render
 * as clickable elements (links open externally, hashtags open the topic)
 */
export function splitContentTokens(text: string): ContentToken[] {
  const parts: ContentToken[] = [];
  const regex = new RegExp(TOKEN_REGEX);
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      const url = trimTrailingPunctuation(match[1]);
      parts.push({ type: 'link', value: url });
      lastIndex = match.index + url.length;
    } else {
      const hashtag = match[2];
      parts.push({ type: 'hashtag', value: hashtag.slice(1) });
      lastIndex = match.index + hashtag.length;
    }
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts;
}
