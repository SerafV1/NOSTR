import { Embed, extractEmbeds } from './media';

/**
 * Half the live events on nostr do not carry a playlist a browser can open —
 * they carry the address of the page the broadcast lives on: twitch.tv,
 * kick.com, youtube.com. Those are watched through the service's own player,
 * which is what the other clients do with them too.
 */
export function streamEmbed(streamingUrl: string, autoplay = false): Embed | null {
  if (!streamingUrl || /\.m3u8(\?|#|$)/i.test(streamingUrl)) return null;

  const embed = extractEmbeds(streamingUrl)[0];
  // A fixed height means an audio widget — no live video comes that way
  if (!embed || embed.height !== null) return null;
  if (!autoplay) return embed;

  return { ...embed, src: withAutoplay(embed) };
}

/** Whether this address plays at all, either way round */
export function streamIsWatchable(streamingUrl: string, hlsPlayable: boolean): boolean {
  return hlsPlayable || !!streamEmbed(streamingUrl);
}

/**
 * Each service spells autoplay its own way. Every one of them starts silent:
 * browsers refuse to play sound the viewer has not asked for, and a picture
 * that never appears is worse than one they have to unmute.
 */
function withAutoplay(embed: Embed): string {
  let url: URL;
  try {
    url = new URL(embed.src);
  } catch {
    return embed.src;
  }

  if (embed.kind === 'youtube') {
    url.searchParams.set('autoplay', '1');
    url.searchParams.set('mute', '1');
  } else if (embed.kind === 'vimeo') {
    url.searchParams.set('autoplay', '1');
    url.searchParams.set('muted', '1');
  } else {
    // Twitch and Kick both read these
    url.searchParams.set('autoplay', 'true');
    url.searchParams.set('muted', 'true');
  }
  return url.toString();
}
