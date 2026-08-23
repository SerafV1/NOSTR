import React, { useEffect, useRef, useState } from 'react';

interface Gif {
  id: string;
  description: string;
  preview: string;
  url: string;
}

interface GifPickerProps {
  /** Given the address of the chosen gif, to put wherever it is being written */
  onSelect: (url: string) => void;
}

/**
 * Search Tenor and pick one. The search runs through this app's own endpoint,
 * which holds the key — see api/gifs.ts.
 */
const GifPicker: React.FC<GifPickerProps> = ({ onSelect }) => {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Typing searches, but only once the typing pauses — a request per
  // keystroke would spend the app's rate limit on half-written words
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/gifs?q=${encodeURIComponent(query)}&limit=24`);
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(response.status === 501
            ? 'GIF search is not set up on this server yet'
            : 'Could not reach the GIF service');
          setGifs([]);
        } else {
          setGifs(body.gifs || []);
        }
      } catch {
        if (!cancelled) setError('Could not reach the GIF service');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 350 : 0);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  return (
    <div className="gif-picker" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        type="text"
        className="gif-picker-search"
        placeholder="Search GIFs…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && <div className="gif-picker-note">{error}</div>}
      {!error && loading && gifs.length === 0 && <div className="gif-picker-note">Searching…</div>}
      {!error && !loading && gifs.length === 0 && (
        <div className="gif-picker-note">Nothing found</div>
      )}

      <div className="gif-picker-grid">
        {gifs.map(gif => (
          <button
            key={gif.id}
            type="button"
            className="gif-picker-item"
            title={gif.description}
            onClick={() => onSelect(gif.url)}
          >
            <img src={gif.preview} alt={gif.description} loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
};

export default GifPicker;
