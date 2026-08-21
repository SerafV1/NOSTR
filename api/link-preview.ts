// Serverless proxy for Open Graph / Twitter Card link previews. A browser
// can't fetch an arbitrary third-party page directly and read its body —
// almost no site sends CORS headers permitting that — so this runs the
// fetch server-side, where CORS doesn't apply, and hands back just the
// parsed tags.

function extractMetaContent(html: string, property: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${property}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// Basic SSRF guard — reject obvious internal/loopback targets before this
// server fetches them on the caller's behalf. Not exhaustive (DNS
// rebinding etc. isn't handled), just keeps this from being a trivial
// internal-network probe.
function safeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    return null;
  }
  return url;
}

// Two attempts, in this order. A plain browser string gets the ordinary page
// from most sites; a few — IMDb among them — answer it with an empty 202 and
// serve the page only to user agents on their list of social crawlers.
// Measured on https://www.imdb.com/title/tt43676563/: browser and any
// honestly-named bot get 202 and no body, while the string below gets the
// full page. It names this app first and carries the token those sites match
// on.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (compatible; NostrLinkPreview/1.0; +https://nostr-ebon.vercel.app) facebookexternalhit/1.1'
];

export default async function handler(req: any, res: any) {
  const raw = req.query?.url;
  const rawUrl = Array.isArray(raw) ? raw[0] : raw;

  if (!rawUrl) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  const url = safeUrl(rawUrl);
  if (!url) {
    res.status(400).json({ error: 'Invalid or disallowed URL' });
    return;
  }

  try {
    let html = '';
    for (const userAgent of USER_AGENTS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { 'User-Agent': userAgent }
        });
        if (response.ok) html = await response.text();
      } catch {
        // This attempt failed; the next user agent may still work
      } finally {
        clearTimeout(timeout);
      }

      // A gated site answers 202 with nothing at all, so "no tags" is the
      // signal to try again rather than to give up
      if (html.includes('og:title') || html.includes('twitter:title') || html.includes('<title')) break;
    }

    if (!html) {
      res.status(200).json({ url: rawUrl });
      return;
    }

    const title = extractMetaContent(html, 'og:title')
      || extractMetaContent(html, 'twitter:title')
      || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    const description = extractMetaContent(html, 'og:description') || extractMetaContent(html, 'twitter:description');
    const image = extractMetaContent(html, 'og:image') || extractMetaContent(html, 'twitter:image');
    const siteName = extractMetaContent(html, 'og:site_name');

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    res.status(200).json({
      url: rawUrl,
      title: title ? decodeHtmlEntities(title.trim()) : undefined,
      description: description ? decodeHtmlEntities(description.trim()) : undefined,
      image: image ? decodeHtmlEntities(image.trim()) : undefined,
      siteName: siteName ? decodeHtmlEntities(siteName.trim()) : undefined
    });
  } catch {
    res.status(200).json({ url: rawUrl });
  }
}
