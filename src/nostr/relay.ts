import * as nostrTools from 'nostr-tools';
import { NostrEventSigned, NostrFilter, RelayConfig, NostrSubscription } from '../types';

declare global {
  interface Window {
    nostrSubscriptions?: Record<string, any[]>;
  }
}

// Log available methods in nostr-tools for debugging
console.log('[RelayPool] nostr-tools keys:', Object.keys(nostrTools));
console.log('[RelayPool] typeof nostrTools:', typeof nostrTools);
if ((nostrTools as any).relayInit) console.log('[RelayPool] ✓ relayInit found');
if ((nostrTools as any).Relay) console.log('[RelayPool] ✓ Relay found');
if ((nostrTools as any).RelayPool) console.log('[RelayPool] ✓ RelayPool found');

export class RelayPool {
  private relays: Map<string, any> = new Map();
  private subscriptions: Map<string, NostrSubscription> = new Map();
  private relayConfigs: RelayConfig[] = [];
  private relayConnectionState: Map<string, boolean> = new Map();
  private relayCapabilities: Map<string, any> = new Map();
  private excludedRelayUrls: Set<string> = new Set();
  private readonly STORAGE_KEY = 'nostr_relay_configs';
  private readonly EXCLUDED_KEY = 'nostr_excluded_relays';

  constructor() {
    // Load saved relay configs on initialization
    this.loadRelayConfigs();
    this.loadExcludedRelays();
  }

  /**
   * Save relay configs to localStorage
   */
  private saveRelayConfigs(): void {
    try {
      // Only save configs for relays that are actually connected
      const activeConfigs = this.relayConfigs.filter(config => this.relays.has(config.url));
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(activeConfigs));
      console.log(`[Relay] Saved ${activeConfigs.length} active relays to storage`);
    } catch (error) {
      console.error(`[Relay] Failed to save relay configs: ${error}`);
    }
  }

  /**
   * Load relay configs from localStorage
   */
  private loadRelayConfigs(): void {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        this.relayConfigs = JSON.parse(stored);
        console.log(`[Relay] Loaded ${this.relayConfigs.length} relays from storage`);
      }
      this.migrateRetiredRelays();
    } catch (error) {
      console.error(`[Relay] Failed to load relay configs: ${error}`);
    }
  }

  /**
   * One-time cleanup: drop retired default relays that older app versions
   * auto-saved to localStorage (dead or paid). Runs once per browser, so a
   * user who deliberately re-adds one later keeps it.
   */
  private migrateRetiredRelays(): void {
    const MIGRATION_KEY = 'nostr_relay_migration_v2';
    if (localStorage.getItem(MIGRATION_KEY)) return;

    const retired = ['wss://relay.nostr.band', 'wss://nostr.wine', 'wss://relay.snort.social'];
    const before = this.relayConfigs.length;
    this.relayConfigs = this.relayConfigs.filter(c => !retired.includes(c.url));
    if (this.relayConfigs.length !== before) {
      console.log(`[Relay] Migration: removed ${before - this.relayConfigs.length} retired relays`);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.relayConfigs));
    }
    localStorage.setItem(MIGRATION_KEY, 'done');
  }

  /**
   * Load excluded relay URLs from localStorage
   */
  private loadExcludedRelays(): void {
    try {
      const stored = localStorage.getItem(this.EXCLUDED_KEY);
      if (stored) {
        this.excludedRelayUrls = new Set(JSON.parse(stored));
        console.log(`[Relay] Loaded ${this.excludedRelayUrls.size} excluded relays`);
      }
    } catch (error) {
      console.error(`[Relay] Failed to load excluded relays: ${error}`);
    }
  }

  /**
   * Save excluded relay URLs to localStorage
   */
  private saveExcludedRelays(): void {
    try {
      localStorage.setItem(this.EXCLUDED_KEY, JSON.stringify(Array.from(this.excludedRelayUrls)));
    } catch (error) {
      console.error(`[Relay] Failed to save excluded relays: ${error}`);
    }
  }

  /**
   * Get excluded relay URLs
   */
  getExcludedRelays(): Set<string> {
    return new Set(this.excludedRelayUrls);
  }

  /**
   * Add a relay to the pool
   */
  async addRelay(url: string, config?: Partial<RelayConfig>): Promise<boolean> {
    try {
      // Only check if relay is already actively connected (in relays Map)
      if (this.relays.has(url)) {
        console.log(`[Relay] ${url} already connected`);
        return true;
      }

      console.log(`[Relay] Adding relay: ${url}`);
      let relay: any = null;
      let relayType = 'unknown';

      // Try to use nostr-tools relay if available
      try {
        if ((nostrTools as any).relayInit) {
          console.log(`[Relay] Using nostr-tools relayInit for ${url}`);
          relayType = 'relayInit';
          relay = await (nostrTools as any).relayInit(url);
        } else if ((nostrTools as any).Relay) {
          console.log(`[Relay] Using nostr-tools Relay for ${url}`);
          relayType = 'Relay';
          relay = (nostrTools as any).Relay(url);
        }
      } catch (toolsError) {
        console.warn(`[Relay] nostr-tools relay failed: ${toolsError}`);
      }

      // Fallback to WebSocket if nostr-tools didn't work
      if (!relay) {
        console.warn(`[Relay] Using WebSocket fallback for ${url}`);
        relayType = 'websocket';
        relay = this.createFallbackRelay(url);
      }

      // Always ensure connect method exists
      if (!relay.connect) {
        console.error(`[Relay] Relay has no connect method: ${url}`);
        return false;
      }

      // Attempt to connect
      console.log(`[Relay] Connecting to ${url} (type: ${relayType})`);
      let isConnected = false;
      try {
        await Promise.race([
          relay.connect(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout after 10s')), 10000)
          )
        ]);
        console.log(`[Relay] ✓ Successfully connected to ${url}`);
        isConnected = true;
      } catch (connectError) {
        console.warn(`[Relay] Connection attempt failed for ${url}: ${connectError}`);
        // Still add relay even if connection failed - it might reconnect later
        isConnected = false;
      }

      this.relays.set(url, relay);
      this.relayConnectionState.set(url, isConnected);
      
      // Only add config if it doesn't already exist
      if (!this.relayConfigs.find(c => c.url === url)) {
        this.relayConfigs.push({
          url,
          read: config?.read !== false,
          write: config?.write !== false
        });
      }
      
      // If re-adding a previously excluded relay, remove from excluded list
      if (this.excludedRelayUrls.has(url)) {
        this.excludedRelayUrls.delete(url);
        this.saveExcludedRelays();
        console.log(`[Relay] Removed ${url} from excluded list`);
      }

      // Save to localStorage
      this.saveRelayConfigs();

      console.log(`[Relay] Added relay ${url}, connected=${isConnected}, type=${relayType}`);
      
      // Fetch capabilities and cache them
      try {
        const cap = await this.getRelayCapabilities(url);
        this.relayCapabilities.set(url, cap);
        console.log(`[Relay] ✓ Capabilities fetched for ${url}`);
      } catch (err) {
        console.log(`[Relay] Capability fetch failed for ${url}:`, err);
      }
      
      return true;
    } catch (error) {
      console.error(`[Relay] Failed to add relay ${url}:`, error);
      return false;
    }
  }

  /**
   * Fallback relay creation for when relayInit is not available
   */
  private createFallbackRelay(url: string): any {
    const relay: any = {
      url,
      connected: false,
      status: 'disconnected',
      socket: null,
      connect: async () => {
        return new Promise<void>((resolve, reject) => {
          console.log(`[WebSocket] Connecting to ${url}`);
          
          try {
            // Check if WebSocket is available
            if (typeof WebSocket === 'undefined') {
              console.error(`[WebSocket] WebSocket not available in this environment`);
              reject(new Error('WebSocket not available'));
              return;
            }

            const ws = new WebSocket(url);
            let connected = false;
            let timeoutId: any = null;

            // Set timeout for connection attempt
            timeoutId = setTimeout(() => {
              if (!connected) {
                console.error(`[WebSocket] Connection timeout for ${url}`);
                ws.close();
                reject(new Error(`Connection timeout for ${url}`));
              }
            }, 10000);

            ws.onopen = () => {
              if (!connected) {
                connected = true;
                if (timeoutId) clearTimeout(timeoutId);
                console.log(`[WebSocket] ✓ Connected to ${url}`);
                relay.connected = true;
                relay.status = 'connected';
                relay.socket = ws;
                resolve();
              }
            };

            ws.onerror = (event) => {
              if (timeoutId) clearTimeout(timeoutId);
              console.error(`[WebSocket] Error for ${url}:`, event);
              relay.connected = false;
              relay.status = 'disconnected';
              if (!connected) {
                connected = true;
                reject(new Error(`WebSocket error for ${url}`));
              }
            };

            ws.onclose = () => {
              console.warn(`[WebSocket] Closed for ${url}`);
              relay.connected = false;
              relay.status = 'disconnected';
              if (!connected && timeoutId) {
                clearTimeout(timeoutId);
                connected = true;
                reject(new Error(`WebSocket closed before connection for ${url}`));
              }
            };

            ws.onmessage = (event) => {
              console.log(`[WebSocket] Message from ${url}:`, event.data?.substring(0, 50));
            };
          } catch (error) {
            console.error(`[WebSocket] Exception creating WebSocket for ${url}:`, error);
            relay.connected = false;
            relay.status = 'disconnected';
            reject(error);
          }
        });
      },
      close: () => {
        try {
          if (relay.socket) {
            console.log(`[WebSocket] Closing ${url}`);
            relay.socket.close();
          }
        } catch (error) {
          console.error(`[WebSocket] Error closing socket for ${url}:`, error);
        }
        relay.connected = false;
        relay.status = 'disconnected';
      },
      publish: async (event: any) => {
        console.log('[WebSocket] Publish (not fully implemented):', event.id);
        if (relay.socket && relay.socket.readyState === WebSocket.OPEN) {
          try {
            relay.socket.send(JSON.stringify(['EVENT', event]));
          } catch (error) {
            console.error('[WebSocket] Error publishing:', error);
          }
        }
        return Promise.resolve();
      },
      subscribe: (_filters: any, _opts: any) => {
        console.log('[WebSocket] Subscribe (not fully implemented)');
        return { unsub: () => {} };
      },
      list: async (_filters: any) => {
        console.log('[WebSocket] REQ query (not fully implemented)');
        return [];
      }
    };
    return relay;
  }

  /**
   * Remove a relay from the pool
   */
  async removeRelay(url: string): Promise<void> {
    const relay = this.relays.get(url);
    if (relay) {
      if (relay.close) {
        relay.close();
      }
      this.relays.delete(url);
      this.relayConfigs = this.relayConfigs.filter(r => r.url !== url);
      
      // If this is a default relay being removed, track it as excluded
      if (DEFAULT_RELAYS.includes(url)) {
        this.excludedRelayUrls.add(url);
        this.saveExcludedRelays();
        console.log(`[Relay] Added ${url} to excluded list`);
      }
      
      // Save to localStorage
      this.saveRelayConfigs();
    }
  }

  /**
   * Get relay count
   */
  getRelayCount(): number {
    return this.relays.size;
  }

  /**
   * Check if we have at least one relay
   */
  hasRelays(): boolean {
    return this.relays.size > 0;
  }

  /**
   * Get all connected relays
   */
  getRelays(): string[] {
    return Array.from(this.relays.keys());
  }

  /**
   * Clean up stale relay configs that don't have active relays
   */
  cleanupStaleConfigs(): void {
    const beforeCount = this.relayConfigs.length;
    
    // First remove duplicates, keeping only the first occurrence of each URL
    const seen = new Set<string>();
    this.relayConfigs = this.relayConfigs.filter(config => {
      if (seen.has(config.url)) return false;
      seen.add(config.url);
      return true;
    });
    
    // Then remove any configs that don't have corresponding active relays
    this.relayConfigs = this.relayConfigs.filter(config => this.relays.has(config.url));
    
    const afterCount = this.relayConfigs.length;
    if (beforeCount !== afterCount) {
      console.log(`[Relay] Cleaned up stale configs: ${beforeCount} → ${afterCount} (deduped and filtered)`);
      this.saveRelayConfigs();
    }
  }

  /**
   * Get all saved relay configs (including inactive ones) - for initialization
   */
  getAllSavedRelayConfigs(): RelayConfig[] {
    // Return all saved configs without filtering
    return [...this.relayConfigs];
  }

  /**
   * Get relay configs - only for relays that are in the active relays map
   */
  getRelayConfigs(): RelayConfig[] {
    // Only return configs for relays that are actually connected
    return this.relayConfigs.filter(config => this.relays.has(config.url));
  }

  /**
   * Get relay capabilities (readable, writable, paid info)
   */
  async getRelayCapabilities(url: string): Promise<{
    readable: boolean;
    writable: boolean;
    paid?: boolean;
    name?: string;
    description?: string;
  }> {
    // Start with permissive defaults
    const result = {
      readable: true,
      writable: true,
      paid: false,
      name: '',
      description: ''
    };

    try {
      // Try to fetch relay info via HTTP (NIP-11)
      // Convert WebSocket URL to HTTP URL
      const httpUrl = url
        .replace(/^wss:\/\//, 'https://')
        .replace(/^ws:\/\//, 'http://');

      console.log(`[Relay] Fetching capabilities for ${url} from ${httpUrl}`);

      const response = await Promise.race([
        fetch(httpUrl, {
          headers: {
            'Accept': 'application/nostr+json'
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Relay info fetch timeout')), 5000)
        )
      ]);

      if (!response.ok) {
        console.warn(`[Relay] HTTP ${response.status} fetching ${httpUrl}`);
        return result;
      }

      const text = await response.text();
      console.log(`[Relay] Raw response body from ${url}:`, text);
      
      const info = JSON.parse(text);
      console.log(`[Relay] Parsed JSON from ${url}:`, info);
      
      // NIP-11 relay info format
      if (typeof info === 'object' && info !== null) {
        // Check read capability - NIP-11: read false means no reads
        result.readable = (info as any).read !== false;
        
        // Check write capability - NIP-11: write false means no writes
        result.writable = (info as any).write !== false;
        
        // Also check limitations
        const limitation = (info as any).limitation;
        if (limitation) {
          // If max_subscriptions is 0, can't read
          if (limitation.max_subscriptions === 0) {
            result.readable = false;
          }
          // If max_event_size is 0, can't write
          if (limitation.max_event_size === 0) {
            result.writable = false;
          }
          // If restricted_writes is true, can't write
          if (limitation.restricted_writes === true) {
            result.writable = false;
          }
        }

        // Check payment required - can be at top level or inside limitation
        // Different relays use different field names
        const fees = (info as any).fees;
        const hasAnyFee = fees && (
          fees.admission !== undefined ||
          fees.publication !== undefined ||
          fees.publishing !== undefined ||
          fees.subscription !== undefined ||
          fees.admin !== undefined ||
          Object.keys(fees).length > 0  // Any fee type defined
        );
        
        const paymentRequired = 
          (info as any).payment_required === true ||
          (info as any).limitation?.payment_required === true ||
          (info as any).payments_required === true ||
          (info as any).limitation?.payments_required === true ||
          (info as any).paid === true ||
          (info as any).payment === true ||
          (info as any).limitation?.paid === true ||
          (info as any).limitation?.payment === true ||
          hasAnyFee;
        
        result.paid = paymentRequired;
        console.log(`[Relay] Payment check: payment_required=${(info as any).payment_required}, limitation.payment_required=${(info as any).limitation?.payment_required}, has fees=${hasAnyFee} → paid=${result.paid}`);
        
        result.name = (info as any).name || '';
        result.description = (info as any).description || '';
        console.log(`[Relay] ✓ Parsed capabilities for ${url}:`, result);
      }
    } catch (error) {
      console.warn(`[Relay] Failed to fetch capabilities for ${url}: ${error}`);
    }

    return result;
  }

  /**
   * Get all relay capabilities (cached)
   */
  getAllCapabilities(): Map<string, any> {
    const capabilities = new Map<string, any>();
    
    for (const url of this.relays.keys()) {
      // Return cached capability or default
      capabilities.set(url, this.relayCapabilities.get(url) ?? {
        readable: true,
        writable: true,
        paid: false,
        name: ''
      });
    }

    return capabilities;
  }

  /**
   * Publish an event to all write relays
   */
  async publishEvent(event: NostrEventSigned): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    const tasks: Promise<void>[] = [];

    for (const [url, relay] of this.relays) {
      const config = this.relayConfigs.find(c => c.url === url);
      if (!config?.write) continue;

      tasks.push(
        (async () => {
          try {
            if (!relay.publish) {
              results.set(url, false);
              return;
            }

            const pub = relay.publish(event);

            // Wait for the relay's OK, but never longer than 5s — a silent
            // relay must not hang the whole publish
            const confirmation = (async () => {
              if (pub && typeof pub.on === 'function') {
                // Older Pub-style API with ok/failed events
                await new Promise<void>((resolve, reject) => {
                  pub.on('ok', () => resolve());
                  pub.on('failed', (reason: unknown) => reject(new Error(String(reason))));
                });
              } else if (pub && typeof pub.then === 'function') {
                // nostr-tools v1.17: publish returns a promise that settles
                // on OK — or never, if the relay stays silent
                await pub;
              }
            })();

            // A late rejection after the timeout wins must not surface
            // as an unhandled promise rejection
            confirmation.catch(() => {});

            await Promise.race([
              confirmation,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('publish confirmation timeout')), 5000)
              )
            ]);

            results.set(url, true);
            console.log(`Event published to ${url}`);
          } catch (error) {
            console.error(`Failed to publish to ${url}:`, error);
            results.set(url, false);
          }
        })()
      );
    }

    await Promise.all(tasks);
    return results;
  }

  /**
   * Subscribe to events from all read relays
   */
  subscribe(
    filters: NostrFilter[],
    callback: (event: NostrEventSigned) => void,
    eoseCallback?: () => void
  ): string {
    const subscriptionId = Math.random().toString(36).substring(7);
    
    const subscription: NostrSubscription = {
      id: subscriptionId,
      filters,
      callback,
      eoseCallback
    };

    this.subscriptions.set(subscriptionId, subscription);

    // Subscribe on each relay
    for (const [url, relay] of this.relays) {
      const config = this.relayConfigs.find(c => c.url === url);
      if (!config?.read) continue;

      try {
        let sub: any;
        
        if (relay.subscribe && typeof relay.subscribe === 'function') {
          sub = relay.subscribe(filters, {
            onevent: (event: NostrEventSigned) => {
              callback(event);
            },
            oneose: () => {
              eoseCallback?.();
            }
          });
        }

        // Store the subscription reference for later cleanup
        if (!window.nostrSubscriptions) {
          window.nostrSubscriptions = {};
        }
        if (!window.nostrSubscriptions[subscriptionId]) {
          window.nostrSubscriptions[subscriptionId] = [];
        }
        if (sub) {
          window.nostrSubscriptions[subscriptionId].push(sub);
        }
      } catch (error) {
        console.error(`Failed to subscribe on ${url}:`, error);
      }
    }

    return subscriptionId;
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(subscriptionId: string): void {
    if (window.nostrSubscriptions && window.nostrSubscriptions[subscriptionId]) {
      window.nostrSubscriptions[subscriptionId].forEach((sub: any) => {
        if (sub.unsub && typeof sub.unsub === 'function') {
          sub.unsub();
        }
      });
      delete window.nostrSubscriptions[subscriptionId];
    }

    this.subscriptions.delete(subscriptionId);
  }

  /**
   * Fetch events from relays (query-based)
   */
  async fetchEvents(filters: NostrFilter[]): Promise<NostrEventSigned[]> {
    const events: Map<string, NostrEventSigned> = new Map();
    const promises: Promise<void>[] = [];

    // Resolves when the first relay delivers data, so we can stop waiting
    // for the slowest relays shortly after
    let signalFirstData!: () => void;
    let firstDataSignaled = false;
    const firstData = new Promise<void>(resolve => { signalFirstData = resolve; });

    for (const [url, relay] of this.relays) {
      const config = this.relayConfigs.find(c => c.url === url);
      if (!config?.read) continue;

      promises.push(
        (async () => {
          try {
            let relayEvents: NostrEventSigned[] = [];

            // Try different query methods with timeout
            const queryPromise = (async () => {
              if (relay.querySync && typeof relay.querySync === 'function') {
                return await relay.querySync(filters);
              } else if (relay.query && typeof relay.query === 'function') {
                return await relay.query(filters);
              } else if (relay.list && typeof relay.list === 'function') {
                return await relay.list(filters);
              }
              return [];
            })();

            // Add 3 second timeout for each relay query
            relayEvents = await Promise.race([
              queryPromise,
              new Promise<NostrEventSigned[]>((resolve) =>
                setTimeout(() => {
                  console.warn(`Query timeout for relay ${url}`);
                  resolve([]);
                }, 3000)
              )
            ]);

            relayEvents.forEach(event => {
              if (!events.has(event.id)) {
                events.set(event.id, event);
              }
            });

            if (relayEvents.length > 0 && !firstDataSignaled) {
              firstDataSignaled = true;
              signalFirstData();
            }
          } catch (error) {
            console.error(`Failed to fetch from ${url}:`, error);
          }
        })()
      );
    }

    // Don't wait for the slowest relay: return 800ms after the first relay
    // delivers data — enough for the fast majority to contribute
    const earlyExit = firstData.then(
      () => new Promise<void>(resolve => setTimeout(resolve, 800))
    );
    await Promise.race([Promise.all(promises).then(() => undefined), earlyExit]);

    return Array.from(events.values());
  }

  /**
   * Close all relay connections
   */
  async closeAll(): Promise<void> {
    for (const relay of this.relays.values()) {
      try {
        if (relay.close && typeof relay.close === 'function') {
          relay.close();
        }
      } catch (error) {
        console.error('Error closing relay:', error);
      }
    }
    this.relays.clear();
    this.relayConfigs = [];
  }

  /**
   * Update relay capabilities (read/write)
   */
  updateRelayCapabilities(url: string, read: boolean, write: boolean): void {
    const config = this.relayConfigs.find(c => c.url === url);
    if (config) {
      config.read = read;
      config.write = write;
      // Save to localStorage
      this.saveRelayConfigs();
    }
  }

  /**
   * Refresh connection status for all relays and reconnect if needed
   */
  async refreshConnectionStatus(): Promise<void> {
    console.log(`[Status] Refreshing connection status for ${this.relays.size} relays`);
    
    for (const [url, relay] of this.relays) {
      try {
        const currentStatus = this.relayConnectionState.get(url) || false;
        console.log(`[Status] Checking ${url}: currently ${currentStatus ? 'connected' : 'disconnected'}`);

        // If relay is not connected, try to reconnect
        if (!currentStatus && relay.connect && typeof relay.connect === 'function') {
          try {
            console.log(`[Status] Attempting to reconnect to ${url}`);
            await Promise.race([
              relay.connect(),
              new Promise<void>((_, reject) => 
                setTimeout(() => reject(new Error('Reconnection timeout')), 10000)
              )
            ]);
            console.log(`[Status] ✓ Reconnected to ${url}`);
            this.relayConnectionState.set(url, true);
          } catch (error) {
            console.log(`[Status] Reconnection failed for ${url}: ${error}`);
            this.relayConnectionState.set(url, false);
          }
        }
      } catch (error) {
        console.error(`[Status] Error refreshing status for ${url}:`, error);
      }
    }
  }

  /**
   * Get relay connection status
   */
  getStatus(): Map<string, boolean> {
    const status = new Map<string, boolean>();
    console.log(`[Status] Getting status for ${this.relays.size} relays`);
    
    for (const [url, relay] of this.relays) {
      let isConnected = this.relayConnectionState.get(url) || false;

      // If we don't have state, check relay object
      if (!isConnected && relay) {
        if (relay.connected === true || relay.status === 'connected') {
          isConnected = true;
        } else if (relay.socket && relay.socket.readyState === WebSocket.OPEN) {
          isConnected = true;
        }
        this.relayConnectionState.set(url, isConnected);
      }

      status.set(url, isConnected);
      console.log(`[Status] ${url}: ${isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}`);
    }
    return status;
  }
}

// Default relay list — free relays that reliably answer queries.
// Dropped: relay.nostr.band (unreachable), relay.snort.social (returns no
// data), nostr.wine (paid). purplepag.es specializes in profile metadata.
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://purplepag.es',
  'wss://nostr-pub.wellorder.net'
];

// Singleton instance
let relayPoolInstance: RelayPool | null = null;

export function getRelayPool(): RelayPool {
  if (!relayPoolInstance) {
    relayPoolInstance = new RelayPool();
  }
  return relayPoolInstance;
}

export function resetRelayPool(): void {
  relayPoolInstance = null;
}
