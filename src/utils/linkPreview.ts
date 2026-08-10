// Open Graph / Twitter Card metadata for link preview cards, fetched via
// our own /api/link-preview serverless function. A direct browser fetch
// of the target page almost always fails — most sites don't send CORS
// headers permitting that — so the actual page fetch + tag parsing runs
// server-side, where CORS doesn't apply.

export interface LinkMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const cache = new Map<string, LinkMetadata>();
const inFlight = new Map<string, Promise<LinkMetadata>>();

async function fetchAndParse(url: string, timeoutMs: number): Promise<LinkMetadata> {
  const response = await Promise.race([
    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('link preview timeout')), timeoutMs))
  ]);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

export async function fetchLinkPreview(url: string, timeoutMs: number = 5000): Promise<LinkMetadata> {
  const cached = cache.get(url);
  if (cached) return cached;

  const pending = inFlight.get(url);
  if (pending) return pending;

  // On failure (network error, or /api/link-preview unavailable — e.g.
  // running `vite dev` locally without `vercel dev`), cache a bare {url}
  // result so the card still renders a plain hostname chip instead of
  // retrying every render
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
