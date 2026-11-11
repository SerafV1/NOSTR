import React, { useEffect, useState } from 'react';
import { BlossomClient, StoredBlob, ServerFailure } from '../nostr/blossom';
import { loadBlossomServers } from '../utils/blossomServers';
import Thumbnail from './Thumbnail';

interface UploadedMediaProps {
  pubkey: string;
}

const KB = 1024;
const readableSize = (bytes: number): string => {
  if (!bytes) return '';
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
};

const isPicture = (blob: StoredBlob): boolean =>
  (blob.type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(blob.url);
const isFilm = (blob: StoredBlob): boolean =>
  (blob.type || '').startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(blob.url);

/** What a file is, in a word, for the ones with no picture to show */
const describe = (blob: StoredBlob): string => {
  if (isFilm(blob)) return '🎬';
  if ((blob.type || '').startsWith('audio/')) return '🎵';
  if ((blob.type || '').includes('pdf')) return '📄';
  return '📦';
};

/**
 * Everything this account has put on its own media servers.
 *
 * The Media tab beside this one is built from posts — the first picture of
 * each note — so it shows neither the second picture of a post nor anything
 * uploaded and never posted, and it has nothing to say about where a file
 * actually lives. This asks the servers themselves (BUD-02) and lists what
 * they hold, with the address to hand and the file to take away.
 */
const UploadedMedia: React.FC<UploadedMediaProps> = ({ pubkey }) => {
  const [blobs, setBlobs] = useState<StoredBlob[] | null>(null);
  const [failed, setFailed] = useState<ServerFailure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  /**
   * Which of the servers from Settings is being worked with: what is listed
   * and where an upload goes. Empty means all of them — everything they
   * hold between them, and an upload offered to each in turn.
   */
  const [target, setTarget] = useState('');
  const [uploading, setUploading] = useState<number | null>(null);
  const servers = loadBlossomServers().filter(server => server.enabled);

  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    let dropped = false;
    setBlobs(null);
    setError(null);
    BlossomClient.list(pubkey)
      .then(({ blobs: found, failed: refused }) => {
        if (dropped) return;
        setBlobs(found);
        setFailed(refused);
      })
      .catch(err => {
        if (!dropped) setError(err instanceof Error ? err.message : 'Could not read your media servers');
      });
    return () => { dropped = true; };
  }, [pubkey, reloadAt]);

  /**
   * Putting something here directly, without writing a post around it —
   * onto whichever of the servers from Settings is chosen, or all of them
   * in turn, which is what an upload from the composer does.
   */
  const add = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      for (const file of Array.from(files)) {
        setUploading(0);
        await BlossomClient.uploadFile(file, target || undefined, pct => setUploading(pct));
      }
      setReloadAt(at => at + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload was refused');
    } finally {
      setUploading(null);
    }
  };

  const copy = async (blob: StoredBlob) => {
    try {
      await navigator.clipboard.writeText(blob.url);
      setCopied(blob.sha256);
      setTimeout(() => setCopied(current => (current === blob.sha256 ? null : current)), 1500);
    } catch {
      setError('This browser would not let the address be copied');
    }
  };

  /**
   * Taking a copy. An anchor's `download` is ignored across origins — the
   * browser navigates to the file instead of saving it — so the file is
   * fetched and handed over as a blob. A server that will not answer a
   * cross-origin request leaves opening it in a tab as the honest fallback.
   */
  const save = async (blob: StoredBlob) => {
    setSaving(blob.sha256);
    try {
      const answer = await fetch(blob.url);
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      const body = await answer.blob();
      const href = URL.createObjectURL(body);
      const link = document.createElement('a');
      link.href = href;
      link.download = blob.url.split('/').pop() || blob.sha256;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
    } catch {
      window.open(blob.url, '_blank', 'noopener');
    } finally {
      setSaving(null);
    }
  };

  if (error && !blobs) return <div className="empty-state"><p>{error}</p></div>;
  if (!blobs) return <div className="loading">Reading your media servers…</div>;

  // Picking one server narrows what is shown to what that server holds: a
  // file commonly sits on several, and the point of choosing one is to see
  // what is on it
  const shown = target ? blobs.filter(blob => blob.servers.includes(target)) : blobs;
  const totalSize = shown.reduce((sum, blob) => sum + blob.size, 0);

  return (
    <div className="uploaded-media">
      <div className="uploaded-media-controls">
        <label className="btn btn-secondary btn-small">
          {uploading === null ? 'Upload a file' : `Uploading… ${uploading}%`}
          <input
            type="file"
            hidden
            multiple
            disabled={uploading !== null}
            onChange={e => { void add(e.target.files); e.target.value = ''; }}
          />
        </label>
        {servers.length > 1 && (
          <select
            value={target}
            onChange={e => setTarget(e.target.value)}
            disabled={uploading !== null}
            title="The server to show and to upload to"
          >
            <option value="">All servers</option>
            {servers.map(server => (
              <option key={server.url} value={server.url}>
                {server.url.replace(/^https?:\/\//, '')}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="uploaded-media-summary">
        {shown.length === 0
          ? (target
            ? `Nothing on ${target.replace(/^https?:\/\//, '')}`
            : 'Nothing on your media servers yet')
          : `${shown.length} file${shown.length === 1 ? '' : 's'}${totalSize ? ` · ${readableSize(totalSize)}` : ''}`}
        {failed.length > 0 && (
          <span className="uploaded-media-refused">
            {' '}· {failed.map(f => `${f.server.replace(/^https?:\/\//, '')} (${f.reason})`).join(', ')}
          </span>
        )}
      </div>

      {error && <p className="uploaded-media-error">{error}</p>}

      <div className="uploaded-media-grid">
        {shown.map(blob => (
          <div className="uploaded-media-item" key={blob.sha256}>
            <a className="uploaded-media-thumb" href={blob.url} target="_blank" rel="noopener noreferrer">
              {isPicture(blob) ? (
                <Thumbnail src={blob.url} width={320} fallback="🖼" fallbackClassName="uploaded-media-plate" />
              ) : (
                <span className="uploaded-media-plate">{describe(blob)}</span>
              )}
            </a>
            <div className="uploaded-media-facts">
              <span title={blob.type || 'unknown type'}>{readableSize(blob.size)}</span>
              {/* Where it actually is, since an upload is offered to each
                  server in turn and may have landed on several */}
              <span className="uploaded-media-where" title={blob.servers.join('\n')}>
                {blob.servers.length === 1
                  ? blob.servers[0].replace(/^https?:\/\//, '')
                  : `${blob.servers.length} servers`}
              </span>
            </div>
            <div className="uploaded-media-actions">
              <button type="button" onClick={() => copy(blob)}>
                {copied === blob.sha256 ? 'Copied' : 'Copy link'}
              </button>
              <button type="button" onClick={() => save(blob)} disabled={saving === blob.sha256}>
                {saving === blob.sha256 ? 'Saving…' : 'Download'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default UploadedMedia;
