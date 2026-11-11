// The head of the page, filled in for a crawler that will not run scripts.
//
// Every address on this site is answered with the same index.html, and the
// title and picture in it are the site's own. For a person that is fine —
// the app loads and writes the real ones in a moment. For the crawlers
// behind link previews it is not: they fetch the file, read the head, and
// never execute anything, so a link to any note, article, profile or
// stream drew the same card saying "RAZR".
//
// A rewrite in vercel.json sends those addresses here, and only when the
// request's user agent is one of those crawlers — everyone else is served
// the static file straight from the CDN, as before, and never waits on
// this. What this does is look the thing up on the relays and write it
// into the head of the very same index.html, so what the crawler is shown
// is what the page itself goes on to say.

import { nip19, SimplePool, type Filter, type Event } from 'nostr-tools-v2';

/** Where to look. The app's own defaults, plus any hint in the address. */
const RELAYS = [
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.satlantis.io',
  'wss://relay.damus.io',
  'wss://nostr.wine',
  'wss://relay.ditto.pub'
];

/** A crawler waits, but not for long, and a slow relay must not hold it */
const RELAY_WAIT = 2500;

const KIND_PROFILE = 0;
const KIND_NOTE = 1;
const KIND_LIVE = 30311;

interface Card {
  title?: string;
  description?: string;
  image?: string;
}

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** One line, collapsed, cut to what a preview card actually shows */
const line = (text: string | undefined, limit: number): string | undefined => {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
};

const tagValue = (event: Event, name: string): string | undefined =>
  event.tags.find(tag => tag[0] === name)?.[1] || undefined;

/**
 * A picture to put on the card. Only an https address is accepted: a
 * crawler will not load anything else, and this value goes into the page.
 */
const picture = (candidate: string | undefined): string | undefined => {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  if (!/^https:\/\/[^\s"'<>]{4,500}$/.test(trimmed)) return undefined;
  return trimmed;
};

/** The first picture written into a note, which is what a client shows */
const firstPictureIn = (content: string): string | undefined =>
  picture(content.match(/https:\/\/\S+\.(?:jpe?g|png|gif|webp|avif)/i)?.[0]);

/** What a profile calls itself, or the short form of its key */
const personName = (profile: Event | null, pubkey: string): string => {
  if (profile) {
    try {
      const meta = JSON.parse(profile.content) as { display_name?: string; name?: string };
      const named = (meta.display_name || meta.name || '').trim();
      if (named) return named;
    } catch {
      // A profile whose content is not JSON tells us nothing; fall through
    }
  }
  return `${pubkey.slice(0, 8)}…`;
};

/**
 * What the address points at. Anything that is not a well-formed nostr
 * address is refused here rather than sent to a relay.
 */
const asFilter = (ref: string): { filter: Filter; hints: string[] } | null => {
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(ref);
  } catch {
    return null;
  }

  if (decoded.type === 'note') return { filter: { ids: [decoded.data] }, hints: [] };
  if (decoded.type === 'nevent') {
    return { filter: { ids: [decoded.data.id] }, hints: decoded.data.relays || [] };
  }
  if (decoded.type === 'naddr') {
    const { kind, pubkey, identifier, relays } = decoded.data;
    return {
      filter: { kinds: [kind], authors: [pubkey], '#d': [identifier] },
      hints: relays || []
    };
  }
  if (decoded.type === 'npub') {
    return { filter: { kinds: [KIND_PROFILE], authors: [decoded.data] }, hints: [] };
  }
  if (decoded.type === 'nprofile') {
    return {
      filter: { kinds: [KIND_PROFILE], authors: [decoded.data.pubkey] },
      hints: decoded.data.relays || []
    };
  }
  return null;
};

/** The card for whatever came back, by what kind of thing it is */
const cardFor = (event: Event, author: Event | null): Card => {
  const who = personName(author, event.pubkey);
  let avatar: string | undefined;
  if (author) {
    try {
      avatar = picture((JSON.parse(author.content) as { picture?: string }).picture);
    } catch {
      avatar = undefined;
    }
  }

  if (event.kind === KIND_PROFILE) {
    let about: string | undefined;
    let own: string | undefined;
    try {
      const meta = JSON.parse(event.content) as { about?: string; picture?: string };
      about = meta.about;
      own = picture(meta.picture);
    } catch {
      // nothing to add
    }
    return {
      title: `${personName(event, event.pubkey)} on nostr`,
      description: line(about, 300),
      image: own
    };
  }

  if (event.kind === KIND_LIVE) {
    return {
      title: tagValue(event, 'title') || `${who}'s stream`,
      description: line(tagValue(event, 'summary'), 300),
      image: picture(tagValue(event, 'image')) || avatar
    };
  }

  // A long-form post carries its own title, summary and banner (NIP-23)
  if (tagValue(event, 'title')) {
    return {
      title: tagValue(event, 'title'),
      description: line(tagValue(event, 'summary') || event.content, 300),
      image: picture(tagValue(event, 'image')) || firstPictureIn(event.content) || avatar
    };
  }

  // A plain note has no title, so it is headed by who wrote it
  if (event.kind === KIND_NOTE) {
    return {
      title: `${who} on nostr`,
      description: line(event.content, 300),
      image: firstPictureIn(event.content) || avatar
    };
  }

  return { title: `${who} on nostr`, description: line(event.content, 300), image: avatar };
};

/** The deployment's own index.html, which is what is being filled in */
let shell: { html: string; at: number } | null = null;
const SHELL_LIFE = 10 * 60 * 1000;

const fetchShell = async (host: string): Promise<string | null> => {
  if (shell && Date.now() - shell.at < SHELL_LIFE) return shell.html;
  try {
    const answer = await fetch(`https://${host}/index.html`, {
      headers: { 'User-Agent': 'razr-preview' },
      signal: AbortSignal.timeout(4000)
    });
    if (!answer.ok) return null;
    const html = await answer.text();
    shell = { html, at: Date.now() };
    return html;
  } catch {
    return null;
  }
};

const replaceProperty = (html: string, property: string, value: string): string =>
  html.replace(
    new RegExp(`(<meta property="${property}" content=")[^"]*(")`),
    `$1${escapeAttribute(value)}$2`
  );

const replaceNamed = (html: string, name: string, value: string): string =>
  html.replace(
    new RegExp(`(<meta name="${name}" content=")[^"]*(")`),
    `$1${escapeAttribute(value)}$2`
  );

const fill = (html: string, card: Card, url: string): string => {
  let out = html;
  if (card.title) {
    const full = `${card.title} · RAZR`;
    out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeAttribute(full)}</title>`);
    out = replaceProperty(out, 'og:title', full);
  }
  if (card.description) {
    out = replaceNamed(out, 'description', card.description);
    out = replaceProperty(out, 'og:description', card.description);
  }
  if (card.image) {
    out = replaceProperty(out, 'og:image', card.image);
    out = replaceNamed(out, 'twitter:image', card.image);
    // The stated size belongs to the site's own picture, not to this one,
    // and a wrong size is worse than none
    out = out.replace(/\s*<meta property="og:image:(?:width|height)" content="\d+" \/>/g, '');
  }
  out = replaceProperty(out, 'og:url', url);
  out = out.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${escapeAttribute(url)}$2`);
  // A single note or profile is a thing somebody wrote, not the site — but
  // only when there is one. With nothing found, what is being served is the
  // site's own head, unchanged, and it should still say so.
  if (card.title) out = replaceProperty(out, 'og:type', 'article');
  return out;
};

export default async function handler(req: any, res: any) {
  const kind = String(req.query?.kind || '');
  const ref = String(req.query?.ref || '');
  const host = String(req.headers?.host || 'razr.social');
  const path = ['e', 'a', 'p', 'live'].includes(kind) ? `/${kind}/${ref}` : '/';
  const url = `https://${host}${path}`;

  const html = await fetchShell(host);
  if (!html) {
    // Nothing to fill in. A redirect keeps the crawler from being handed an
    // error page for an address that works perfectly well.
    res.statusCode = 302;
    res.setHeader('Location', path);
    res.end();
    return;
  }

  const send = (body: string, seconds: number, status = 200) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=86400`);
    res.statusCode = status;
    res.end(body);
  };

  const target = asFilter(ref);
  if (!target) {
    // Not a nostr address at all, so there is no page here and no relay to
    // ask. Saying 404 keeps a crawler from filing an address somebody made
    // up as a page of this site.
    send(fill(html, {}, url), 3600, 404);
    return;
  }

  const relays = Array.from(new Set([...target.hints.filter(r => r.startsWith('wss://')), ...RELAYS]));
  const pool = new SimplePool();
  try {
    const found = await pool.querySync(relays, { ...target.filter, limit: 1 }, { maxWait: RELAY_WAIT });
    const event = found.sort((a, b) => b.created_at - a.created_at)[0];
    if (!event) {
      // Say nothing rather than something made up
      send(fill(html, {}, url), 300);
      return;
    }

    let author: Event | null = null;
    if (event.kind !== KIND_PROFILE) {
      // Who is presenting a stream is not always who published the event
      const host53 = event.tags.find(tag => tag[0] === 'p' && tag[3] === 'Host')?.[1];
      author = await pool
        .get(relays, { kinds: [KIND_PROFILE], authors: [host53 || event.pubkey] }, { maxWait: RELAY_WAIT })
        .catch(() => null);
    }

    // A live event is rewritten as the stream goes on; a note never changes
    send(fill(html, cardFor(event, author), url), event.kind === KIND_LIVE ? 120 : 86400);
  } catch {
    send(fill(html, {}, url), 300);
  } finally {
    try {
      pool.close(relays);
    } catch {
      // Already closed; nothing to do
    }
  }
}
