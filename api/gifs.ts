// Tenor search, proxied.
//
// The key belongs to whoever runs this app, and a key shipped to the browser
// is a key given away — so the browser asks this, and this asks Tenor. It
// also keeps the response down to what a picker needs: a preview to show and
// one URL to post.

interface TenorMediaFormats {
  gif?: { url: string; dims?: number[] };
  mediumgif?: { url: string };
  tinygif?: { url: string; dims?: number[] };
}

interface TenorResult {
  id: string;
  content_description?: string;
  media_formats?: TenorMediaFormats;
}

export default async function handler(req: any, res: any) {
  const key = process.env.TENOR_API_KEY;
  if (!key) {
    // Said plainly, so the picker can explain itself rather than look broken
    res.status(501).json({ error: 'GIF search is not configured on this server' });
    return;
  }

  const raw = req.query?.q;
  const query = (Array.isArray(raw) ? raw[0] : raw || '').toString().trim().slice(0, 100);
  const limitRaw = Number(Array.isArray(req.query?.limit) ? req.query.limit[0] : req.query?.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 24;

  const endpoint = query
    ? 'https://tenor.googleapis.com/v2/search'
    : 'https://tenor.googleapis.com/v2/featured';

  const params = new URLSearchParams({
    key,
    limit: String(limit),
    // Only the two sizes used here, instead of the dozen Tenor returns
    media_filter: 'gif,tinygif',
    contentfilter: 'medium',
    client_key: 'razr'
  });
  if (query) params.set('q', query);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    let response: Response;
    try {
      response = await fetch(`${endpoint}?${params}`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      res.status(502).json({ error: 'Tenor did not answer' });
      return;
    }

    const body = await response.json() as { results?: TenorResult[] };
    const gifs = (body.results || [])
      .map(result => ({
        id: result.id,
        description: result.content_description || '',
        // The small one to browse, the full one to post
        preview: result.media_formats?.tinygif?.url,
        url: result.media_formats?.gif?.url
      }))
      .filter(gif => gif.preview && gif.url);

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
    res.status(200).json({ gifs });
  } catch {
    res.status(502).json({ error: 'Could not reach Tenor' });
  }
}
