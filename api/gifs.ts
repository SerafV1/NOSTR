// GIF search, proxied.
//
// The key belongs to whoever runs this app, and a key shipped to the browser
// is a key given away — so the browser asks this, and this asks the GIF
// service. It also keeps the response down to what a picker needs: a preview
// to show and one URL to post.
//
// Giphy by default, since it still hands out keys. Tenor stopped taking new
// clients in January 2026, so it is only worth reaching for by anyone holding
// a key from before then — hence the second branch rather than none.

interface Gif {
  id: string;
  description: string;
  preview?: string;
  url?: string;
}

interface GiphyImage { url?: string }

interface GiphyResult {
  id: string;
  title?: string;
  images?: Record<string, GiphyImage>;
}

interface TenorResult {
  id: string;
  content_description?: string;
  media_formats?: Record<string, { url: string }>;
}

/** Six seconds, then give up: a picker that hangs is worse than one that says so */
async function ask(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fromGiphy(key: string, query: string, limit: number): Promise<Gif[]> {
  const params = new URLSearchParams({
    api_key: key,
    limit: String(limit),
    // Nothing that would embarrass someone typing into a public chat
    rating: 'pg-13'
  });
  if (query) params.set('q', query);

  const endpoint = query
    ? 'https://api.giphy.com/v1/gifs/search'
    : 'https://api.giphy.com/v1/gifs/trending';

  const response = await ask(`${endpoint}?${params}`);
  if (!response.ok) throw new Error(`giphy ${response.status}`);

  const body = await response.json() as { data?: GiphyResult[] };
  return (body.data || []).map(result => {
    const images = result.images || {};
    return {
      id: result.id,
      description: result.title || '',
      // Small enough to browse a gridful of
      preview: images.fixed_width_small?.url || images.fixed_width?.url,
      // Trimmed rather than original: originals run to tens of megabytes,
      // and this URL is what everyone reading the chat will load
      url: images.downsized_medium?.url || images.downsized?.url || images.original?.url
    };
  });
}

async function fromTenor(key: string, query: string, limit: number): Promise<Gif[]> {
  const params = new URLSearchParams({
    key,
    limit: String(limit),
    // Only the two sizes used here, instead of the dozen Tenor returns
    media_filter: 'gif,tinygif',
    contentfilter: 'medium',
    client_key: 'razr'
  });
  if (query) params.set('q', query);

  const endpoint = query
    ? 'https://tenor.googleapis.com/v2/search'
    : 'https://tenor.googleapis.com/v2/featured';

  const response = await ask(`${endpoint}?${params}`);
  if (!response.ok) throw new Error(`tenor ${response.status}`);

  const body = await response.json() as { results?: TenorResult[] };
  return (body.results || []).map(result => ({
    id: result.id,
    description: result.content_description || '',
    preview: result.media_formats?.tinygif?.url,
    url: result.media_formats?.gif?.url
  }));
}

export default async function handler(req: any, res: any) {
  const giphyKey = process.env.GIPHY_API_KEY;
  const tenorKey = process.env.TENOR_API_KEY;
  if (!giphyKey && !tenorKey) {
    // Said plainly, so the picker can explain itself rather than look broken
    res.status(501).json({ error: 'GIF search is not configured on this server' });
    return;
  }

  const raw = req.query?.q;
  const query = (Array.isArray(raw) ? raw[0] : raw || '').toString().trim().slice(0, 100);
  const limitRaw = Number(Array.isArray(req.query?.limit) ? req.query.limit[0] : req.query?.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 24;

  try {
    const gifs = giphyKey
      ? await fromGiphy(giphyKey, query, limit)
      : await fromTenor(tenorKey as string, query, limit);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.status(200).json({ gifs: gifs.filter(gif => gif.preview && gif.url) });
  } catch {
    res.status(502).json({ error: 'Could not reach the GIF service' });
  }
}
