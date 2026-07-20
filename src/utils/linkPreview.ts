// Best-effort Open Graph / Twitter Card metadata for link preview cards.
// There's no backend to proxy through, so this fetches the page directly
// from the browser — most sites don't send CORS headers for arbitrary
// origins, so this frequently fails. That's expected: on failure we cache
// a bare {url} result so the card still renders a plain hostname chip
// instead of retrying (or breaking) on every render.

export interface LinkMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const cache = new Map<string, LinkMetadata>();
const inFlight = new Map<string, Promise<LinkMetadata>>();

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

function decodeHtmlEntities(text: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

async function fetchAndParse(url: string, timeoutMs: number): Promise<LinkMetadata> {
  const response = await Promise.race([
    fetch(url),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('link preview timeout')), timeoutMs))
  ]);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const html = await response.text();
  const title = extractMetaContent(html, 'og:title')
    || extractMetaContent(html, 'twitter:title')
    || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const description = extractMetaContent(html, 'og:description') || extractMetaContent(html, 'twitter:description');
  const image = extractMetaContent(html, 'og:image') || extractMetaContent(html, 'twitter:image');
  const siteName = extractMetaContent(html, 'og:site_name');

  return {
    url,
    title: title ? decodeHtmlEntities(title.trim()) : undefined,
    description: description ? decodeHtmlEntities(description.trim()) : undefined,
    image: image ? decodeHtmlEntities(image.trim()) : undefined,
    siteName: siteName ? decodeHtmlEntities(siteName.trim()) : undefined
  };
}

export async function fetchLinkPreview(url: string, timeoutMs: number = 5000): Promise<LinkMetadata> {
  const cached = cache.get(url);
  if (cached) return cached;

  const pending = inFlight.get(url);
  if (pending) return pending;

  const promise = fetchAndParse(url, timeoutMs)
    .catch(() => ({ url }))
    .then(result => {
      cache.set(url, result);
      inFlight.delete(url);
      return result;
    });

  inFlight.set(url, promise);
  return promise;
}
