import { PersistentCache } from '../nostr/core';

/**
 * A relay's own mark.
 *
 * A relay's NIP-11 information document may name an `icon`, which is the
 * picture its operator chose — but plenty of relays publish none, and plenty
 * of those that do point at their own /favicon.ico, which a browser will not
 * draw cross-origin: measured here, .ico from nos.lol, nostr.mom and
 * relay.damus.io all failed to load as images while ordinary .png files from
 * the same hosts loaded.
 *
 * So a named icon is used only when it is a picture format that renders, and
 * everything else goes through the same favicon service this app already
 * uses for link previews, which answers in PNG.
 */
const CACHE_KEY = 'relay_icons';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Known {
  icon: string;
  at: number;
}

let memory: Record<string, Known> | null = null;
const asking = new Set<string>();

const read = (): Record<string, Known> => {
  if (!memory) memory = PersistentCache.get<Record<string, Known>>(CACHE_KEY) || {};
  return memory;
};

export const relayHost = (url: string): string => {
  try {
    return new URL(url.replace(/^ws/, 'http')).hostname;
  } catch {
    return url.replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
  }
};

/** Formats a browser will actually draw from another origin */
const DRAWABLE = /\.(png|jpe?g|webp|gif|svg)(\?|$)/i;

/**
 * The mark to draw for a relay: what it names, when that is a format that
 * renders, and otherwise its favicon by way of the service that returns one
 * as a PNG.
 */
export const relayIconSrc = (url: string, named: string | null): string => {
  if (named && DRAWABLE.test(named)) return named;
  return `https://www.google.com/s2/favicons?domain=${relayHost(url)}&sz=64`;
};

/** The icon already known for this relay, if any: '' means "use the favicon" */
export const knownRelayIcon = (url: string): string | null => {
  const entry = read()[relayHost(url)];
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) return null;
  return entry.icon;
};

/**
 * Ask the relay what its icon is, once. The answer — including "it names
 * none" — is remembered for a week, so a feed of a hundred notes does not
 * ask the same handful of relays a hundred times.
 */
export const loadRelayIcon = async (url: string): Promise<string> => {
  const host = relayHost(url);
  if (asking.has(host)) return '';
  const cached = knownRelayIcon(url);
  if (cached !== null) return cached;

  asking.add(host);
  let icon = '';
  try {
    const response = await fetch(`https://${host}`, {
      headers: { Accept: 'application/nostr+json' }
    });
    if (response.ok) {
      const info = await response.json() as { icon?: string };
      if (typeof info.icon === 'string' && /^https?:\/\//.test(info.icon)) icon = info.icon;
    }
  } catch {
    // Not every relay allows this from a browser; the favicon still might work
  } finally {
    asking.delete(host);
  }

  const store = read();
  store[host] = { icon, at: Date.now() };
  PersistentCache.set(CACHE_KEY, store);
  return icon;
};
