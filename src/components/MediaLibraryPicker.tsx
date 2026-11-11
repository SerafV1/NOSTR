import React, { useEffect, useState } from 'react';
import { BlossomClient, StoredBlob } from '../nostr/blossom';
import { loadBlossomServers } from '../utils/blossomServers';
import { CredentialManager } from '../nostr/crypto';
import Thumbnail from './Thumbnail';

interface MediaLibraryPickerProps {
  /** Given the address of whatever was chosen */
  onPick: (url: string) => void;
  onClose: () => void;
}

const isPicture = (blob: StoredBlob): boolean =>
  (blob.type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(blob.url);

const mark = (blob: StoredBlob): string => {
  if ((blob.type || '').startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(blob.url)) return '🎬';
  if ((blob.type || '').startsWith('audio/')) return '🎵';
  return '📦';
};

/**
 * Something already on your own media servers, to put in a post or a line of
 * chat without uploading it again.
 *
 * Everything posted here was uploaded from here, and uploading the same
 * picture twice makes a second copy of it on every server that takes it —
 * a blob is named by its hash, so the second copy is the same file under
 * the same name, but the round trip was spent for nothing. This lists what
 * is already there and hands over its address.
 */
const MediaLibraryPicker: React.FC<MediaLibraryPickerProps> = ({ onPick, onClose }) => {
  const [blobs, setBlobs] = useState<StoredBlob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState('');
  const servers = loadBlossomServers().filter(s => s.enabled);
  const pubkey = CredentialManager.getPublicKey();

  useEffect(() => {
    if (!pubkey) {
      setError('Log in to see your own media');
      return;
    }
    let dropped = false;
    BlossomClient.list(pubkey)
      .then(({ blobs: found }) => { if (!dropped) setBlobs(found); })
      .catch(err => {
        if (!dropped) setError(err instanceof Error ? err.message : 'Could not read your media servers');
      });
    return () => { dropped = true; };
  }, [pubkey]);

  // Escape closes it, the way every other popup in here behaves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = (blobs || []).filter(blob => !server || blob.servers.includes(server));

  return (
    <div className="media-library">
      <div className="media-library-head">
        <span>Your media</span>
        {servers.length > 1 && (
          <select value={server} onChange={e => setServer(e.target.value)} title="Which server to show">
            <option value="">All servers</option>
            {servers.map(s => (
              <option key={s.url} value={s.url}>{s.url.replace(/^https?:\/\//, '')}</option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="media-library-note">{error}</p>}
      {!error && !blobs && <p className="media-library-note">Reading your media servers…</p>}
      {!error && blobs && shown.length === 0 && (
        <p className="media-library-note">Nothing here yet — anything you upload will be.</p>
      )}

      <div className="media-library-grid">
        {shown.map(blob => (
          <button
            key={blob.sha256}
            type="button"
            className="media-library-item"
            title={blob.url}
            onClick={() => { onPick(blob.url); onClose(); }}
          >
            {isPicture(blob)
              ? <Thumbnail src={blob.url} width={200} fallback="🖼" fallbackClassName="media-library-plate" />
              : <span className="media-library-plate">{mark(blob)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MediaLibraryPicker;
