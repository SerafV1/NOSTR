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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          // A generic browser UA gets more consistent OG tags than an
          // unrecognized bot UA, which some sites serve a stripped page to
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      res.status(200).json({ url: rawUrl });
      return;
    }

    const html = await response.text();
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
