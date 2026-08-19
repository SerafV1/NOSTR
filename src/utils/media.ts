// Shared helpers for detecting and stripping media URLs in note content

const IMAGE_URL_SOURCE = 'https?:\\/\\/[^\\s]+\\.(?:jpg|jpeg|png|gif|webp|bmp|svg)(?:\\?[^\\s]*)?';
const VIDEO_URL_SOURCE = 'https?:\\/\\/[^\\s]+\\.(?:mp4|webm|mov|m4v|ogv)(?:\\?[^\\s]*)?';
const ANY_URL_SOURCE = 'https?:\\/\\/[^\\s]+';
// A quoted note reference (NIP-19 note/nevent/naddr) — rendered as an
// embedded quote card, so the raw reference is hidden from the visible text.
//
// The `nostr:` prefix is optional because plenty of clients publish a bare
// "nevent1…", and requiring it left those as a wall of bech32 in the middle
// of a post. What must not match is a reference inside a URL — a link to
// njump.me/nevent1… is a link, not a quote — hence the guard on what may
// come before it.
const QUOTE_REF_SOURCE = '(?<![\\w/.:])(?:nostr:)?(?:note1|nevent1|naddr1)[a-z0-9]{20,}';

/** Shared so the quote card, the stripper and the resolver agree on one shape */
export const quoteRefRegex = (flags = 'gi'): RegExp => new RegExp(QUOTE_REF_SOURCE, flags);

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

export type EmbedKind =
  | 'youtube'
  | 'vimeo'
  | 'twitch'
  | 'spotify'
  | 'soundcloud'
  | 'applemusic'
  | 'deezer'
  | 'tidal';

export interface Embed {
  /** Dedupe key — the same track linked twice renders one player */
  id: string;
  kind: EmbedKind;
  /** URL to load in the iframe */
  src: string;
  title: string;
  /**
   * Audio widgets have a fixed pixel height set by the provider; null means
   * a video embed, laid out as a responsive 16:9 box instead
   */
  height: number | null;
  /** Poster image, only where the URL alone is enough to derive one */
  thumbnail?: string;
}

interface EmbedProvider {
  kind: EmbedKind;
  /** Unanchored so it can double as the strip-from-text pattern */
  source: string;
  build: (match: RegExpMatchArray, url: string) => Omit<Embed, 'kind'> | null;
}

// Twitch refuses to frame unless it's told which page is doing the framing
const twitchParent = (): string =>
  typeof window === 'undefined' ? 'localhost' : window.location.hostname;

const EMBED_PROVIDERS: EmbedProvider[] = [
  {
    kind: 'youtube',
    source:
      'https?:\\/\\/(?:(?:www|m|music)\\.)?(?:youtube\\.com\\/(?:watch\\?v=|shorts\\/|live\\/|embed\\/)|youtu\\.be\\/)([A-Za-z0-9_-]{11})[^\\s]*',
    build: ([, id]) => ({
      id,
      src: `https://www.youtube-nocookie.com/embed/${id}`,
      title: 'YouTube video',
      height: null,
      thumbnail: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    }),
  },
  {
    kind: 'vimeo',
    source: 'https?:\\/\\/(?:www\\.)?vimeo\\.com\\/(?:video\\/)?(\\d+)[^\\s]*',
    build: ([, id]) => ({
      id,
      src: `https://player.vimeo.com/video/${id}`,
      title: 'Vimeo video',
      height: null,
    }),
  },
  {
    kind: 'twitch',
    source: 'https?:\\/\\/clips\\.twitch\\.tv\\/([A-Za-z0-9_-]+)[^\\s]*',
    build: ([, slug]) => ({
      id: `clip:${slug}`,
      src: `https://clips.twitch.tv/embed?clip=${slug}&parent=${twitchParent()}`,
      title: 'Twitch clip',
      height: null,
    }),
  },
  {
    kind: 'twitch',
    // Ordered alternation: /videos/<id> and /<user>/clip/<slug> must win over
    // the bare-channel branch, which would otherwise swallow them
    source:
      'https?:\\/\\/(?:(?:www|m)\\.)?twitch\\.tv\\/(?:videos\\/(\\d+)|[A-Za-z0-9_]+\\/clip\\/([A-Za-z0-9_-]+)|([A-Za-z0-9_]{3,25}))[^\\s]*',
    build: ([, videoId, clipSlug, channel]) => {
      const parent = twitchParent();
      if (videoId) {
        return {
          id: `video:${videoId}`,
          src: `https://player.twitch.tv/?video=${videoId}&parent=${parent}&autoplay=false`,
          title: 'Twitch video',
          height: null,
        };
      }
      if (clipSlug) {
        return {
          id: `clip:${clipSlug}`,
          src: `https://clips.twitch.tv/embed?clip=${clipSlug}&parent=${parent}`,
          title: 'Twitch clip',
          height: null,
        };
      }
      return {
        id: `channel:${channel}`,
        src: `https://player.twitch.tv/?channel=${channel}&parent=${parent}&autoplay=false`,
        title: `Twitch — ${channel}`,
        height: null,
      };
    },
  },
  {
    kind: 'spotify',
    source:
      'https?:\\/\\/open\\.spotify\\.com\\/(?:intl-[a-z]{2}\\/)?(track|album|playlist|episode|show|artist)\\/([A-Za-z0-9]+)[^\\s]*',
    build: ([, type, id]) => ({
      id: `${type}:${id}`,
      src: `https://open.spotify.com/embed/${type}/${id}`,
      title: `Spotify ${type}`,
      // Spotify's own recommended sizes: compact for a single track,
      // taller for anything that renders a tracklist
      height: type === 'track' ? 152 : type === 'episode' ? 232 : 352,
    }),
  },
  {
    kind: 'soundcloud',
    // The widget takes the original permalink, so no ID lookup is needed
    source:
      'https?:\\/\\/(?:(?:www|m)\\.)?soundcloud\\.com\\/[A-Za-z0-9_-]+\\/(?:sets\\/)?[A-Za-z0-9_-]+[^\\s]*',
    build: (_match, url) => {
      const isSet = /\/sets\//.test(url);
      const params = new URLSearchParams({
        url,
        color: '#ff5500',
        auto_play: 'false',
        hide_related: 'true',
        show_comments: 'false',
        show_teaser: 'false',
      });
      return {
        id: url,
        src: `https://w.soundcloud.com/player/?${params.toString()}`,
        title: 'SoundCloud',
        height: isSet ? 300 : 166,
      };
    },
  },
  {
    kind: 'applemusic',
    source: 'https?:\\/\\/music\\.apple\\.com\\/[^\\s]+',
    build: (_match, url) => ({
      id: url,
      src: url.replace('//music.apple.com', '//embed.music.apple.com'),
      title: 'Apple Music',
      // A single song — either the /song/ route or an album deep-linked
      // to one track with ?i= — gets the one-row player
      height: /\/song\/|[?&]i=/.test(url) ? 175 : 450,
    }),
  },
  {
    kind: 'deezer',
    source:
      'https?:\\/\\/(?:www\\.)?deezer\\.com\\/(?:[a-z]{2}\\/)?(track|album|playlist)\\/(\\d+)[^\\s]*',
    build: ([, type, id]) => ({
      id: `${type}:${id}`,
      src: `https://widget.deezer.com/widget/dark/${type}/${id}`,
      title: `Deezer ${type}`,
      height: type === 'track' ? 152 : 300,
    }),
  },
  {
    kind: 'tidal',
    source:
      'https?:\\/\\/(?:(?:www|listen)\\.)?tidal\\.com\\/(?:browse\\/)?(track|album|playlist|video)\\/([A-Za-z0-9-]+)[^\\s]*',
    build: ([, type, id]) => ({
      id: `${type}:${id}`,
      src: `https://embed.tidal.com/${type}s/${id}`,
      title: `Tidal ${type}`,
      height: type === 'video' ? null : type === 'track' ? 96 : 400,
    }),
  },
];

/**
 * Every link in the content that a provider can render as an inline player,
 * in the order they appear. Adding a service here makes it show up in the
 * feed, quotes, compose preview and search at once.
 */
export function extractEmbeds(content: string): Embed[] {
  const embeds: Embed[] = [];
  const seen = new Set<string>();
  const matches = content.match(new RegExp(ANY_URL_SOURCE, 'gi')) || [];

  for (const raw of matches) {
    const url = trimTrailingPunctuation(raw);
    for (const provider of EMBED_PROVIDERS) {
      const match = url.match(new RegExp(`^${provider.source}`, 'i'));
      if (!match) continue;
      const built = provider.build(match, url);
      if (!built) break;
      const key = `${provider.kind}:${built.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        embeds.push({ ...built, kind: provider.kind });
      }
      break;
    }
  }
  return embeds;
}

const isEmbeddable = (url: string): boolean =>
  EMBED_PROVIDERS.some(p => new RegExp(`^${p.source}`, 'i').test(url));

/**
 * First link in the content that isn't already rendered as an image, video
 * or player embed — used to show a single X/Twitter-style preview card
 * for the one "real" link in a note, same as most clients do.
 */
export function extractPreviewLinkUrl(content: string): string | null {
  const images = new Set(extractImageUrls(content));
  const videos = new Set(extractVideoUrls(content));
  const matches = content.match(new RegExp(ANY_URL_SOURCE, 'gi')) || [];

  for (const raw of matches) {
    const url = trimTrailingPunctuation(raw);
    if (images.has(url) || videos.has(url) || isEmbeddable(url)) continue;
    return url;
  }
  return null;
}

/**
 * Media URLs get rendered as previews, so drop them from the visible text
 */
export function stripMediaUrls(content: string): string {
  let cleaned = content;
  const sources = [
    IMAGE_URL_SOURCE,
    VIDEO_URL_SOURCE,
    ...EMBED_PROVIDERS.map(p => p.source),
    QUOTE_REF_SOURCE,
  ];
  for (const source of sources) {
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
