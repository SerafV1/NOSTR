import { nip19 } from 'nostr-tools';
import { NostrEventSigned } from '../types';

export type LiveStreamStatus = 'planned' | 'live' | 'ended';

export interface LiveStreamInfo {
  id: string;
  /** Author of the event — often a platform account, not the streamer */
  pubkey: string;
  /**
   * Who is actually presenting: NIP-53 marks them with a 'p' tag whose
   * role is "Host". On platform-published streams (zap.stream and the
   * like) that differs from the event author, and it's the host who has a
   * Lightning address and should get the zap.
   */
  hostPubkey: string;
  dTag: string;
  title: string;
  summary: string;
  image: string;
  streamingUrl: string;
  status: LiveStreamStatus;
  starts?: number;
  currentParticipants?: number;
  hashtags: string[];
}

// Plenty of broadcasters never publish an "ended" update when they stop
// streaming — their kind 30311 event just sits there tagged "live"
// forever. A genuinely active stream's client keeps republishing it
// (viewer counts, etc.), so a "live" tag that hasn't been refreshed in
// hours is almost certainly stale, not actually live.
const LIVE_STALE_SECONDS = 3 * 60 * 60;

/**
 * A broadcast carried on twitch, kick or youtube rather than on a playlist of
 * its own. Those events are usually published once when the channel goes on
 * air and never touched again, so the freshness rule below — which is there to
 * hide a playlist that has gone dead — would bury a broadcast that is running.
 * There is nothing to go dead here: the service's own player says whether the
 * channel is on air.
 */
const HOSTED_ELSEWHERE = /https?:\/\/(?:[\w-]+\.)*(?:twitch\.tv|kick\.com|youtube\.com|youtu\.be|vimeo\.com)\//i;
const HOSTED_STALE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Why a stream cannot be played here, if it cannot. Two cases the browser
 * will never get past, and both look identical from inside the player: it
 * simply never receives a byte, and the page sits on "Connecting…" forever.
 */
export function unplayableReason(streamingUrl: string): string | null {
  if (!streamingUrl) return null;

  let url: URL;
  try {
    url = new URL(streamingUrl);
  } catch {
    return 'This stream\'s address is not a valid URL';
  }

  // A page served over https may not load http media — the browser blocks it
  // before any request is made
  if (url.protocol === 'http:' && window.location.protocol === 'https:') {
    return 'This stream is published over http, which a page served over https is not allowed to play. The broadcaster needs an https address.';
  }

  // Addresses that exist only inside someone's own network: 10/8, 172.16/12,
  // 192.168/16, 127/8, and the carrier-grade range 100.64/10 that Tailscale
  // and mobile networks hand out
  const host = url.hostname;
  const privateRanges = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
  ];
  if (host === 'localhost' || host.endsWith('.local') || privateRanges.some(r => r.test(host))) {
    return `This stream is published at ${host}, an address that only exists inside the broadcaster's own network — nobody outside it can reach the video.`;
  }

  return null;
}

export function isEffectivelyLive(event: NostrEventSigned): boolean {
  const status = event.tags.find(t => t[0] === 'status')?.[1];
  if (status !== 'live') return false;
  const age = Math.floor(Date.now() / 1000) - (event.created_at || 0);
  const streaming = event.tags.find(t => t[0] === 'streaming')?.[1] || '';
  const window = HOSTED_ELSEWHERE.test(streaming) ? HOSTED_STALE_SECONDS : LIVE_STALE_SECONDS;
  return age <= window;
}

// NIP-53 live event (kind 30311) is addressable — parse its tags into a
// plain object once, instead of re-scanning event.tags everywhere it's used
export function parseLiveEvent(event: NostrEventSigned): LiveStreamInfo {
  const tag = (name: string) => event.tags.find(t => t[0] === name)?.[1];
  const rawStatus = tag('status');
  const status: LiveStreamStatus = rawStatus === 'planned'
    ? 'planned'
    : (rawStatus === 'live' && isEffectivelyLive(event)) ? 'live' : 'ended';

  const hostTag = event.tags.find(t => t[0] === 'p' && (t[3] || '').toLowerCase() === 'host');

  return {
    id: event.id,
    pubkey: event.pubkey,
    hostPubkey: hostTag?.[1] || event.pubkey,
    dTag: tag('d') || '',
    title: tag('title') || 'Untitled stream',
    summary: tag('summary') || '',
    image: tag('image') || '',
    streamingUrl: tag('streaming') || '',
    status,
    starts: tag('starts') ? Number(tag('starts')) : undefined,
    currentParticipants: tag('current_participants') ? Number(tag('current_participants')) : undefined,
    hashtags: event.tags.filter(t => t[0] === 't').map(t => t[1])
  };
}

/**
 * The post that announces a stream, in the words the moment calls for: one
 * shared after it ended must not announce itself as live, and naming
 * yourself in your own announcement reads as though a stranger wrote it.
 *
 * The stream's own address and nothing else goes in it. A web link beside it
 * meant two references to one stream, which clients that draw both showed as
 * two things in one post.
 *
 * `sharedBy` is whoever is posting, so the line knows whether this is their
 * own stream — and whoever is presenting is named in it otherwise, which
 * puts the post in their notifications. A stream shared without the streamer
 * hearing of it helps nobody.
 */
export function streamShareText(
  info: LiveStreamInfo,
  naddr: string,
  sharedBy: string | null
): string {
  const own = sharedBy !== null && sharedBy === info.hostPubkey;
  const lead = own
    ? (info.status === 'live'
        ? '🔴 I am live now'
        : info.status === 'planned' ? 'Coming up' : 'This was live')
    : (info.status === 'live'
        ? '🔴 Live now with'
        : info.status === 'planned' ? 'Coming up, with' : 'Was live with');

  const mention = own ? '' : (() => {
    try {
      return `nostr:${nip19.npubEncode(info.hostPubkey)}`;
    } catch {
      // An unencodable key is no reason to lose the rest of the post
      return '';
    }
  })();

  return [
    info.title,
    mention ? `\n\n${lead} ${mention}` : `\n\n${lead}`,
    `\n\nnostr:${naddr}`
  ].join('');
}

// Addressable events are identified by (kind, pubkey, d) rather than event
// id — an naddr is the stable, shareable reference across edits/relays
export function encodeLiveNaddr(kind: number, pubkey: string, dTag: string): string {
  return nip19.naddrEncode({ kind, pubkey, identifier: dTag });
}

export function decodeLiveNaddr(naddr: string): { kind: number; pubkey: string; identifier: string } | null {
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== 'naddr') return null;
    const { kind, pubkey, identifier } = decoded.data as { kind: number; pubkey: string; identifier: string };
    return { kind, pubkey, identifier };
  } catch {
    return null;
  }
}

/**
 * The other way to name a stream: by whoever is presenting it.
 *
 * Every stream is a new `d` tag, so its naddr changes each time somebody
 * goes on air — and a widget address built on one has to be pasted into OBS
 * again for every broadcast. An npub in the same place says "whatever this
 * person is streaming now", which is the address a broadcaster can set up
 * once and leave alone.
 */
export function encodeHostParam(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

/** An npub — or bare hex, for a hand-typed link — as a pubkey */
export function decodeHostParam(param: string): string | null {
  if (/^[0-9a-f]{64}$/i.test(param)) return param.toLowerCase();
  try {
    const decoded = nip19.decode(param);
    return decoded.type === 'npub' ? (decoded.data as string) : null;
  } catch {
    return null;
  }
}

/**
 * The same page, addressed the other way: `/live/<naddr>/chat` and
 * `/live/<npub>/chat` are the same widget, one pinned to this broadcast and
 * one following the broadcaster.
 */
export function readdressed(pathname: string, param: string): string {
  const parts = pathname.split('/');
  // ['', 'live', '<param>', …]
  if (parts.length < 3 || parts[1] !== 'live') return pathname;
  parts[2] = param;
  return parts.join('/');
}

/**
 * The stream a link points at, if it points at one.
 *
 * A stream gets shared as a page address far more often than as a bare
 * `naddr` — someone copies what is in the address bar. Every client that has
 * such a page puts the naddr in the path (this app's /live/…, zap.stream's
 * root, njump's), so the shape to look for is a path segment that is one,
 * whoever is hosting it.
 *
 * Only live events come back: the same path may carry an article or a group
 * address, and neither is something to play.
 */
export function streamNaddrFromUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }

  for (const segment of path.split('/')) {
    const candidate = segment.trim().toLowerCase();
    if (!candidate.startsWith('naddr1')) continue;
    const decoded = decodeLiveNaddr(candidate);
    if (decoded?.kind === 30311) return candidate;
  }
  return null;
}

/**
 * Every stream a note points at, however it was written: as this app's page
 * address, as another client's, or as a bare `naddr` — which is what nostr
 * clients understand, and so what a note meant to be read anywhere carries.
 *
 * The same stream written twice, once as a link and once as an address,
 * comes back once.
 */
export function extractStreamRefs(content: string): { naddr: string; url?: string }[] {
  const found: { naddr: string; url?: string }[] = [];
  const seen = new Set<string>();

  for (const { url, naddr } of extractStreamPageLinks(content)) {
    seen.add(naddr);
    found.push({ naddr, url });
  }

  const bare = content.match(/(?:nostr:)?naddr1[a-z0-9]{20,}/gi) || [];
  for (const raw of bare) {
    const naddr = raw.replace(/^nostr:/i, '').toLowerCase();
    if (seen.has(naddr)) continue;
    if (decodeLiveNaddr(naddr)?.kind !== 30311) continue;
    seen.add(naddr);
    found.push({ naddr });
  }

  return found;
}

/** Every stream page linked in a note, paired with the link it came from */
export function extractStreamPageLinks(content: string): { url: string; naddr: string }[] {
  const found: { url: string; naddr: string }[] = [];
  const seen = new Set<string>();
  const matches = content.match(/https?:\/\/[^\s]+/gi) || [];

  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?)]+$/, '');
    const naddr = streamNaddrFromUrl(url);
    if (!naddr || seen.has(naddr)) continue;
    seen.add(naddr);
    found.push({ url, naddr });
  }
  return found;
}

// The "<kind>:<pubkey>:<d-tag>" coordinate NIP-53 live chat messages (kind
// 1311) reference in their 'a' tag to say which stream they belong to
export function liveEventAddress(kind: number, pubkey: string, dTag: string): string {
  return `${kind}:${pubkey}:${dTag}`;
}
