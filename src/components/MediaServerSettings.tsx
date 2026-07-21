import React, { useState } from 'react';
import {
  BlossomServerConfig,
  loadBlossomServers,
  addBlossomServer,
  removeBlossomServer,
  toggleBlossomServer
} from '../utils/blossomServers';

const MediaServerSettings: React.FC = () => {
  const [servers, setServers] = useState<BlossomServerConfig[]>(() => loadBlossomServers());
  const [newServerUrl, setNewServerUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAddServer = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = newServerUrl.trim();
    if (!trimmed) {
      setError('Server URL cannot be empty');
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('Server URL must start with http:// or https://');
      return;
    }

    setServers(addBlossomServer(trimmed));
    setNewServerUrl('');
  };

  const handleRemoveServer = (url: string) => {
    setServers(removeBlossomServer(url));
  };

  const handleToggleServer = (url: string) => {
    setServers(toggleBlossomServer(url));
  };

  return (
    <section className="settings-section">
      <h2>Media Servers</h2>
      <p className="settings-hint">
        Photos and videos you attach to posts are uploaded to these servers using the
        Blossom protocol. When more than one is enabled, the composer lets you pick which
        one to use, or upload to all of them in order until one accepts the file.
      </p>

      <div className="relay-stats">
        <div className="relay-stat">
          <span className="relay-stat-label">Total Servers</span>
          <span className="relay-stat-value">{servers.length}</span>
        </div>
        <div className="relay-stat">
          <span className="relay-stat-label">Enabled</span>
          <span className="relay-stat-value">{servers.filter(s => s.enabled).length}</span>
        </div>
      </div>

      <form className="add-relay-form" onSubmit={handleAddServer}>
        <div className="relay-input-group">
          <input
            type="text"
            className="relay-input"
            placeholder="https://your-blossom-server.com"
            value={newServerUrl}
            onChange={(e) => setNewServerUrl(e.target.value)}
          />
          <button type="submit" className="add-relay-btn">
            Add Server
          </button>
        </div>
      </form>

      {error && <div className="error-message">{error}</div>}

      <div className="relays-list">
        <h3 style={{ marginTop: 0 }}>Configured Servers</h3>
        {servers.length === 0 ? (
          <div className="no-relays">
            <p>No media servers configured. Add one above to enable photo/video uploads.</p>
          </div>
        ) : (
          servers.map(server => (
            <div key={server.url} className="relay-card">
              <div className="relay-header">
                <div className="relay-url">{server.url}</div>
                <div className={`relay-status ${server.enabled ? 'connected' : 'disconnected'}`}>
                  <span className="relay-status-indicator"></span>
                  {server.enabled ? 'Enabled' : 'Disabled'}
                </div>
              </div>

              <div className="relay-capabilities">
                <div className="capability">
                  <label>
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={() => handleToggleServer(server.url)}
                    />
                    <span>Enabled for uploads</span>
                  </label>
                </div>
              </div>

              <button
                className="remove-relay-btn"
                onClick={() => handleRemoveServer(server.url)}
              >
                Remove Server
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
};

export default MediaServerSettings;
