import React, { useState, useEffect } from 'react';
import { getRelayPool } from '../nostr/relay';
import { RelayConfig } from '../types';

interface RelayWithCapabilities extends RelayConfig {
  connected: boolean;
  readable?: boolean;
  writable?: boolean;
  paid?: boolean;
  paymentRequired?: boolean;
  authRequired?: boolean;
  restrictedWrites?: boolean;
  paymentsUrl?: string;
  feeSummary?: string;
  name?: string;
  description?: string;
}

const RelaySettings: React.FC = () => {
  const [relays, setRelays] = useState<RelayWithCapabilities[]>([]);
  const [newRelayUrl, setNewRelayUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  const loadRelays = async (fetchCapabilities: boolean = false) => {
    const relayPool = getRelayPool();

    // Refresh connection status (attempts to reconnect disconnected relays)
    await relayPool.refreshConnectionStatus();

    const configs = relayPool.getRelayConfigs();
    const status = relayPool.getStatus();

    let relaysWithStatus = configs.map(config => ({
      ...config,
      connected: status.get(config.url) || false
    }));

    // Only fetch capabilities on first load or when requested
    if (fetchCapabilities || !initialized) {
      const capabilities = relayPool.getAllCapabilities();
      console.log('[Settings] All capabilities:', capabilities);
      relaysWithStatus = relaysWithStatus.map(r => ({
        ...r,
        readable: capabilities.get(r.url)?.readable ?? true,
        writable: capabilities.get(r.url)?.writable ?? true,
        paid: capabilities.get(r.url)?.paid ?? false,
        paymentRequired: capabilities.get(r.url)?.paymentRequired ?? false,
        authRequired: capabilities.get(r.url)?.authRequired ?? false,
        restrictedWrites: capabilities.get(r.url)?.restrictedWrites ?? false,
        paymentsUrl: capabilities.get(r.url)?.paymentsUrl ?? '',
        feeSummary: capabilities.get(r.url)?.feeSummary ?? '',
        name: capabilities.get(r.url)?.name ?? '',
        description: capabilities.get(r.url)?.description ?? ''
      }));
      if (!initialized) setInitialized(true);
    }

    setRelays(relaysWithStatus);
  };

  useEffect(() => {
    loadRelays(true); // Fetch capabilities on initial load
    // Refresh relay status every 5 seconds (without re-fetching capabilities)
    const interval = setInterval(() => loadRelays(false), 5000);
    return () => clearInterval(interval);
  }, []);

  const handleAddRelay = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!newRelayUrl.trim()) {
      setError('Relay URL cannot be empty');
      return;
    }

    setLoading(true);
    try {
      const relayPool = getRelayPool();
      const success = await relayPool.addRelay(newRelayUrl.trim());

      if (success) {
        setNewRelayUrl('');
        loadRelays(true); // Now capabilities are guaranteed to be populated
      } else {
        setError('Failed to add relay');
      }
    } catch (err) {
      console.error('Error adding relay:', err);
      setError('Error adding relay');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveRelay = async (url: string) => {
    setLoading(true);
    try {
      const relayPool = getRelayPool();
      await relayPool.removeRelay(url);
      loadRelays();
    } catch (err) {
      console.error('Error removing relay:', err);
      setError('Error removing relay');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleRead = async (url: string) => {
    const relay = relays.find(r => r.url === url);
    if (relay) {
      const relayPool = getRelayPool();
      relayPool.updateRelayCapabilities(url, !relay.read, relay.write);
      loadRelays();
    }
  };

  const handleToggleWrite = async (url: string) => {
    const relay = relays.find(r => r.url === url);
    if (relay) {
      const relayPool = getRelayPool();
      relayPool.updateRelayCapabilities(url, relay.read, !relay.write);
      loadRelays();
    }
  };

  const handleReconnectAll = async () => {
    setLoading(true);
    try {
      const relayPool = getRelayPool();
      await relayPool.refreshConnectionStatus();
      await loadRelays(true); // Fetch capabilities when reconnecting
    } catch (err) {
      console.error('Error reconnecting relays:', err);
      setError('Error reconnecting relays');
    } finally {
      setLoading(false);
    }
  };

  const handleDebugConsole = () => {
    const relayPool = getRelayPool();
    console.log('=== RELAY DEBUG INFO ===');
    console.log('Relay Configs:', relayPool.getRelayConfigs());
    console.log('Relay Status:', relayPool.getStatus());
    console.log('Relay Count:', relayPool.getRelayCount());
    console.log('======================');
  };

  return (
    <section className="settings-section">
      <h2>Relay Management</h2>

      <div className="relay-stats">
        <div className="relay-stat">
          <span className="relay-stat-label">Total Relays</span>
          <span className="relay-stat-value">{relays.length}</span>
        </div>
        <div className="relay-stat">
          <span className="relay-stat-label">Connected</span>
          <span className="relay-stat-value">{relays.filter(r => r.connected).length}</span>
        </div>
      </div>

      <div className="relay-actions">
        <button
          className="btn btn-secondary"
          onClick={handleReconnectAll}
          disabled={loading}
        >
          {loading ? 'Reconnecting...' : 'Reconnect All Relays'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={handleDebugConsole}
        >
          📋 Debug Console
        </button>
      </div>

      <form className="add-relay-form" onSubmit={handleAddRelay}>
        <div className="relay-input-group">
          <input
            type="text"
            className="relay-input"
            placeholder="wss://relay.example.com"
            value={newRelayUrl}
            onChange={(e) => setNewRelayUrl(e.target.value)}
            disabled={loading}
          />
          <button
            type="submit"
            className="add-relay-btn"
            disabled={loading}
          >
            {loading ? 'Adding...' : 'Add Relay'}
          </button>
        </div>
      </form>

      {error && <div className="error-message">{error}</div>}

      <div className="relays-list">
        <h3 style={{ marginTop: 0 }}>Configured Relays</h3>
        {relays.length === 0 ? (
          <div className="no-relays">
            <p>No relays configured. Add one above to get started.</p>
          </div>
        ) : (
          [...new Set(relays.map(r => r.url))].map(url => {
            const relay = relays.find(r => r.url === url)!;
            return (
            <div key={relay.url} className="relay-card">
              <div className="relay-header">
                <div className="relay-url">{relay.url}</div>
                <div className={`relay-status ${relay.connected ? 'connected' : 'disconnected'}`}>
                  <span className="relay-status-indicator"></span>
                  {relay.connected ? 'Connected' : 'Disconnected'}
                </div>
              </div>

              <div className="relay-info-row">
                <div className="relay-capability-status">
                  <span className={`capability-indicator ${relay.readable !== false ? 'enabled' : 'disabled'}`}>
                    {relay.readable !== false ? '✓' : '✗'} Readable
                  </span>
                  <span className={`capability-indicator ${relay.writable !== false ? 'enabled' : 'disabled'}`}>
                    {relay.writable !== false ? '✓' : '✗'} Writable
                  </span>
                  {relay.paymentRequired && (
                    relay.paymentsUrl ? (
                      <a
                        className="capability-indicator paid"
                        href={relay.paymentsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Opens this relay's payment page"
                      >
                        💳 Payment required{relay.feeSummary ? ` — ${relay.feeSummary}` : ''} ↗
                      </a>
                    ) : (
                      <span className="capability-indicator paid">
                        💳 Payment required{relay.feeSummary ? ` — ${relay.feeSummary}` : ''}
                      </span>
                    )
                  )}
                  {relay.restrictedWrites && (
                    <span className="capability-indicator restricted" title="This relay only accepts posts from accounts it has approved">
                      ✍️ Restricted writes
                    </span>
                  )}
                  {relay.authRequired && (
                    <span className="capability-indicator restricted" title="NIP-42: this relay requires you to authenticate with your key before it accepts posts">
                      🔒 Auth required
                    </span>
                  )}
                  {relay.name && (
                    <span className="relay-name" title={relay.description}>
                      {relay.name}
                    </span>
                  )}
                </div>
              </div>

              <div className="relay-capabilities">
                <div className="capability">
                  <label>
                    <input
                      type="checkbox"
                      checked={relay.read}
                      onChange={() => handleToggleRead(relay.url)}
                    />
                    <span>Enable Reading</span>
                  </label>
                </div>
                <div className="capability">
                  <label>
                    <input
                      type="checkbox"
                      checked={relay.write}
                      onChange={() => handleToggleWrite(relay.url)}
                    />
                    <span>Writable (Publish)</span>
                  </label>
                </div>
              </div>

              <button
                className="remove-relay-btn"
                onClick={() => handleRemoveRelay(relay.url)}
                disabled={loading}
              >
                Remove Relay
              </button>
            </div>
            );
          })
        )}
      </div>
    </section>
  );
};

export default RelaySettings;
