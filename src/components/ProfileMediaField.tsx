import React, { useRef, useState } from 'react';
import { BlossomClient } from '../nostr/blossom';
import { loadBlossomServers } from '../utils/blossomServers';
import MediaLibraryPicker from './MediaLibraryPicker';

interface ProfileMediaFieldProps {
  id: 'picture' | 'banner';
  label: string;
  placeholder: string;
  value: string;
  onChange: (url: string) => void;
}

/**
 * A profile picture or banner: typed as an address, chosen from what is
 * already on your own media servers, or uploaded to one of them from here.
 *
 * It used to be an address and nothing else, so changing a picture meant
 * uploading it somewhere else first and copying the link back.
 */
const ProfileMediaField: React.FC<ProfileMediaFieldProps> = ({ id, label, placeholder, value, onChange }) => {
  const servers = loadBlossomServers().filter(s => s.enabled);
  const [server, setServer] = useState(servers[0]?.url || '');
  const [picking, setPicking] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Choose a picture');
      return;
    }
    setError(null);
    setPicking(false);
    setProgress(0);
    try {
      const blob = await BlossomClient.uploadFile(file, server || undefined, pct => setProgress(pct));
      onChange(blob.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload did not go through');
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <div className="profile-media-field">
        <input
          type="url"
          id={id}
          name={id}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {value && <img src={value} alt="" className={`profile-media-preview ${id}`} />}
      </div>
      <div className="profile-media-actions">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => setPicking(p => !p)}
          title="Choose a picture already on your media servers"
        >
          From my media
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => fileRef.current?.click()}
          disabled={progress !== null || servers.length === 0}
          title={servers.length === 0 ? 'Add a media server in Settings first' : 'Upload a picture from this device'}
        >
          {progress !== null ? `Uploading… ${Math.round(progress)}%` : 'Upload'}
        </button>
        {servers.length > 1 && (
          <select
            className="profile-media-server"
            value={server}
            onChange={e => setServer(e.target.value)}
            title="Which of your media servers to upload to"
          >
            {servers.map(s => (
              <option key={s.url} value={s.url}>{s.url.replace(/^https?:\/\//, '')}</option>
            ))}
          </select>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) upload(file);
          }}
        />
      </div>
      {error && <p className="profile-media-error">{error}</p>}
      {picking && (
        <div className="media-library-popup profile-media-picker">
          <MediaLibraryPicker picturesOnly onClose={() => setPicking(false)} onPick={onChange} />
        </div>
      )}
    </div>
  );
};

export default ProfileMediaField;
