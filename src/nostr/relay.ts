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

  /**
   * Which relays each event was seen on — filled as answers arrive, and when
   * one is published. Nothing else in the app knows this: an event handed up
   * from the pool carries no trace of where it came from, so a note could not
   * say which relays actually have it.
   *
   * Bounded, because a feed left open all day would otherwise remember every
   * id it ever saw. The oldest entries go first, which are the ones scrolled
   * past long ago.
   */
  private seenOn: Map<string, Set<string>> = new Map();
  private static readonly SEEN_LIMIT = 4000;
  private relayCapabilities: Map<string, any> = new Map();
  // Consecutive query timeouts per relay — readyState reports OPEN for a
  // "zombie" connection (server/proxy dropped it without a close
  // handshake), so it never looks disconnected. Repeated silent timeouts
  // are the only real signal something's actually wrong with the socket.
  private relayTimeoutCounts: Map<string, number> = new Map();
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
      this.migrateBrokenZapStreamRelay();
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
   * One-time cleanup: "wss://relay.zap.stream" was briefly a default relay
   * here, but the domain doesn't actually exist (a wrong guess) — anyone
   * who loaded the app during that window has it stuck in their saved
   * config, retrying a connection that can never succeed.
   */
  private migrateBrokenZapStreamRelay(): void {
    const MIGRATION_KEY = 'nostr_relay_migration_v3';
    if (localStorage.getItem(MIGRATION_KEY)) return;

    const before = this.relayConfigs.length;
    this.relayConfigs = this.relayConfigs.filter(c => c.url !== 'wss://relay.zap.stream');
    if (this.relayConfigs.length !== before) {
      console.log('[Relay] Migration: removed nonexistent wss://relay.zap.stream');
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

      // Adding a relay mid-session (Settings, or app startup filling in
      // the default set) must pick up whatever live subscriptions are
      // already active — otherwise this relay silently misses them until
      // something happens to fully resubscribe later
      if (isConnected) {
        this.applyActiveSubscriptions(url, relay);
      }

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
   * How many read relays are actually reachable right now. Lets a caller
   * tell "the relays answered, and you really have no such event" apart
   * from "nothing answered" — the difference between those two is whether
   * publishing a replaceable event would create it or destroy it.
   */
  getConnectedRelayCount(): number {
    let count = 0;
    for (const [url, relay] of this.relays) {
      const config = this.relayConfigs.find(c => c.url === url);
      if (config?.read && this.isActuallyConnected(relay)) count++;
    }
    return count;
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
  async getRelayCapabilities(url: string): Promise<RelayCapabilities> {
    // Start with permissive defaults
    const result: RelayCapabilities = {
      readable: true,
      writable: true,
      paid: false,
      // Why a relay won't take your posts is the part worth showing: a bare
      // "not writable" leaves you guessing whether it's broken, private, or
      // simply wants paying
      paymentRequired: false,
      authRequired: false,
      restrictedWrites: false,
      paymentsUrl: '',
      feeSummary: '',
      writeBlockedReason: '',
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
            result.restrictedWrites = true;
          }
          // NIP-42: the relay will take posts, but only after you
          // authenticate with your key
          if (limitation.auth_required === true) {
            result.authRequired = true;
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
        result.paymentRequired = paymentRequired;
        result.paymentsUrl = (info as any).payments_url || '';

        // Quote the actual price when the relay states one — NIP-11 fees are
        // arrays of { amount, unit, period? }, in msats unless said otherwise
        const feeEntry = fees && (fees.admission?.[0] || fees.publication?.[0] || fees.subscription?.[0]);
        if (feeEntry && typeof feeEntry.amount === 'number') {
          const unit = feeEntry.unit || 'msats';
          const sats = unit === 'msats' ? Math.round(feeEntry.amount / 1000) : feeEntry.amount;
          const label = unit === 'msats' || unit === 'sats' ? 'sats' : unit;
          result.feeSummary = `${sats.toLocaleString()} ${label}`;
        }
        console.log(`[Relay] Payment check: payment_required=${(info as any).payment_required}, limitation.payment_required=${(info as any).limitation?.payment_required}, has fees=${hasAnyFee} → paid=${result.paid}`);
        
        // Anything the relay demands before it accepts a post means posts
        // from here will bounce: this client can't pay an invoice, can't be
        // on an allow-list, and doesn't implement NIP-42 auth. Reporting
        // such a relay as writable is a promise the next publish won't keep
        // — which is why a paid relay used to sit there marked "✓ Writable"
        // right next to "payment required".
        const blockers = [
          result.paymentRequired && 'payment required',
          result.restrictedWrites && 'restricted writes',
          result.authRequired && 'auth required (NIP-42, not supported here)'
        ].filter(Boolean) as string[];
        if (blockers.length > 0) {
          result.writable = false;
          result.writeBlockedReason = blockers.join(', ');
        }

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
        paymentRequired: false,
        authRequired: false,
        restrictedWrites: false,
        paymentsUrl: '',
        feeSummary: '',
        writeBlockedReason: '',
        name: ''
      });
    }

    return capabilities;
  }

  /**
   * What a relay actually did with this account's last post, in the relay's
   * own words. NIP-11 states a relay's general policy; only a real publish
   * says whether *you* may write — someone who has paid a paid relay gets
   * an OK, and their next visit to settings should reflect that rather than
   * the blanket "payment required" the relay advertises to everyone.
   */
  private writeOutcomesKey(pubkey: string): string {
    return `nostr_relay_write_${pubkey}`;
  }

  private recordWriteOutcome(pubkey: string, url: string, accepted: boolean, reason: string): void {
    try {
      const all = this.getWriteOutcomes(pubkey);
      all[url] = { accepted, reason, at: Math.floor(Date.now() / 1000) };
      localStorage.setItem(this.writeOutcomesKey(pubkey), JSON.stringify(all));
    } catch {
      // best-effort: this only ever improves what settings can tell you
    }
  }

  getWriteOutcomes(pubkey: string): Record<string, { accepted: boolean; reason: string; at: number }> {
    if (!pubkey) return {};
    try {
      return JSON.parse(localStorage.getItem(this.writeOutcomesKey(pubkey)) || '{}');
    } catch {
      return {};
    }
  }

  /**
   * Publish an event to all write relays
   */
  /** The relays this account would write to, in the order they are tried */
  getWriteRelayUrls(): string[] {
    return [...this.relays.keys()].filter(url =>
      this.relayConfigs.find(config => config.url === url)?.write
    );
  }

  async publishEvent(
    event: NostrEventSigned,
    /** Called as each relay answers, so a publish can be watched happening */
    onRelayResult?: (url: string, accepted: boolean) => void
  ): Promise<Map<string, boolean>> {
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
              onRelayResult?.(url, false);
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
            onRelayResult?.(url, true);
            // A relay that took the note has it, which is what the note's own
            // card goes on to show — so a post says where it landed
            this.recordSeen(event.id, url);
            this.recordWriteOutcome(event.pubkey, url, true, '');
            console.log(`Event published to ${url}`);
          } catch (error) {
            console.error(`Failed to publish to ${url}:`, error);
            results.set(url, false);
            onRelayResult?.(url, false);
            const reason = error instanceof Error ? error.message : String(error);
            // A silent relay proves nothing about whether this account may
            // write — only a relay that actually answered does
            if (!reason.includes('publish confirmation timeout')) {
              this.recordWriteOutcome(event.pubkey, url, false, reason);
            }
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
      this.applySubscriptionToRelay(url, relay, subscriptionId, subscription);
    }

    return subscriptionId;
  }

  /**
   * Issue one already-registered live subscription's REQ on one specific
   * relay object. Split out of subscribe() so it can also be called
   * whenever a relay (re)connects — see applyActiveSubscriptions below.
   */
  private applySubscriptionToRelay(
    url: string,
    relay: any,
    subscriptionId: string,
    subscription: NostrSubscription
  ): void {
    const config = this.relayConfigs.find(c => c.url === url);
    if (!config?.read) return;

    try {
      let sub: any;
      const { filters, callback, eoseCallback } = subscription;

      // nostr-tools relayInit (v1.x, what's actually installed) returns
      // .sub(filters) + .on('event'|'eose', cb) — not the newer
      // Relay-class .subscribe(filters, {onevent, oneose}) shape. Support
      // both so this doesn't silently no-op again on a version bump.
      if (relay.sub && typeof relay.sub === 'function') {
        sub = relay.sub(filters);
        sub.on('event', (event: NostrEventSigned) => {
          this.recordSeen(event.id, url);
          callback(event);
        });
        if (eoseCallback) {
          sub.on('eose', () => {
            eoseCallback();
          });
        }
      } else if (relay.subscribe && typeof relay.subscribe === 'function') {
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

  /**
   * Re-issue every currently active live subscription's REQ on one relay.
   * A relay's underlying WebSocket doesn't remember old .sub() calls made
   * on a previous connection — reconnecting (whether from a health check,
   * fetchEvents' own reconnect-before-query logic, or zombie-timeout
   * forced reconnects) silently drops every live subscription on that
   * relay unless something re-applies them to the new socket. Without
   * this, a feed could go quiet for minutes after any relay hiccup, with
   * "new posts" only resurfacing whenever the app happened to fully
   * resubscribe some other way (e.g. tab visibility change).
   */
  private applyActiveSubscriptions(url: string, relay: any): void {
    for (const [subscriptionId, subscription] of this.subscriptions) {
      this.applySubscriptionToRelay(url, relay, subscriptionId, subscription);
    }
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
   * Fetch events from relays (query-based). By default returns ~800ms
   * after the first relay delivers any data, instead of waiting for the
   * slowest one — good for feed loads where a fast partial result beats a
   * slow complete one. Pass `waitForAll: true` for lookups where a single
   * slow-but-correct relay must not be cut off by a faster relay that
   * simply has other, unrelated matches (e.g. fetching one specific
   * addressable event by coordinate).
   */
  /** Remember that this relay had this event */
  private recordSeen(eventId: string, url: string): void {
    let relays = this.seenOn.get(eventId);
    if (!relays) {
      if (this.seenOn.size >= RelayPool.SEEN_LIMIT) {
        // Map iterates in insertion order, so this is the oldest id
        const oldest = this.seenOn.keys().next().value;
        if (oldest) this.seenOn.delete(oldest);
      }
      relays = new Set();
      this.seenOn.set(eventId, relays);
    }
    relays.add(url);
  }

  /** The relays known to carry this event, in the order they answered */
  getSeenOn(eventId: string): string[] {
    return [...(this.seenOn.get(eventId) || [])];
  }

  async fetchEvents(filters: NostrFilter[], waitForAll: boolean = false): Promise<NostrEventSigned[]> {
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

            const readyState = this.getReadyState(relay);

            if (readyState === WebSocket.CONNECTING) {
              // Already mid-connect (e.g. app startup's initial addRelay(),
              // if a query fires before that settles) — wait for THAT
              // attempt instead of calling connect() again, which would
              // start a second concurrent attempt on the same relay object
              // and could stomp on the one already in flight.
              const start = Date.now();
              while (this.getReadyState(relay) === WebSocket.CONNECTING && Date.now() - start < 4000) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            } else if (readyState !== WebSocket.OPEN && relay.connect && typeof relay.connect === 'function') {
              // Actually closed/closing — a socket that died quietly
              // (backgrounded tab, sleep, network drop) just hangs a query
              // until our own timeout below, so give it a quick chance to
              // reconnect first instead of assuming it's still open.
              try {
                await Promise.race([
                  relay.connect(),
                  new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Reconnect timeout')), 4000))
                ]);
                // A fresh socket doesn't carry over subscriptions issued on
                // the old one — reattach every active live subscription now
                this.applyActiveSubscriptions(url, relay);
              } catch {
                // Still couldn't connect — fall through and let the query
                // below time out/fail quickly rather than retrying here
              }
            }
            this.relayConnectionState.set(url, this.isActuallyConnected(relay));

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
            let timedOut = false;
            relayEvents = await Promise.race([
              queryPromise,
              new Promise<NostrEventSigned[]>((resolve) =>
                setTimeout(() => {
                  console.warn(`Query timeout for relay ${url}`);
                  timedOut = true;
                  resolve([]);
                }, 3000)
              )
            ]);

            if (timedOut) {
              const count = (this.relayTimeoutCounts.get(url) || 0) + 1;
              this.relayTimeoutCounts.set(url, count);
              // Two in a row despite readyState saying OPEN — that's a
              // zombie connection. Force it closed and reconnect so the
              // *next* query actually stands a chance, rather than looking
              // "connected" forever and timing out every single time.
              if (count >= 2) {
                console.warn(`[Relay] ${url} timed out ${count}x in a row — forcing reconnect`);
                this.relayTimeoutCounts.set(url, 0);
                try {
                  relay.close?.();
                } catch { /* already gone */ }
                relay.connect?.().then(
                  () => this.applyActiveSubscriptions(url, relay),
                  (error: unknown) => console.warn(`[Relay] Forced reconnect failed for ${url}:`, error)
                );
              }
            } else {
              this.relayTimeoutCounts.set(url, 0);
            }

            relayEvents.forEach(event => {
              // Every relay that answered with it, not only the first: the
              // point is to show where a note actually lives
              this.recordSeen(event.id, url);
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

    if (waitForAll) {
      await Promise.all(promises);
    } else {
      // Don't wait for the slowest relay: return 800ms after the first relay
      // delivers data — enough for the fast majority to contribute
      const earlyExit = firstData.then(
        () => new Promise<void>(resolve => setTimeout(resolve, 800))
      );
      await Promise.race([Promise.all(promises).then(() => undefined), earlyExit]);
    }

    return Array.from(events.values());
  }

  /**
   * Query relays outside our configured pool — a one-off lookup, nothing
   * gets added to relayConfigs or persisted. Used for the NIP-65 "outbox"
   * case: an author's own write relays, which might not be anywhere in
   * our default set, so their events (e.g. a live stream) would otherwise
   * never be found even though they're publishing correctly.
   */
  async fetchEventsFromExtraRelays(urls: string[], filters: NostrFilter[]): Promise<NostrEventSigned[]> {
    const events: Map<string, NostrEventSigned> = new Map();

    await Promise.all(urls.map(async (url) => {
      // Reuse an already-connected relay instead of opening a second
      // connection to the same server
      const existing = this.relays.get(url);
      let relay = existing;
      let temporary = false;
      // The raw connect call, kept separate from the timeout race below —
      // if it resolves *after* we've already given up on it, the socket it
      // opened has no reference left anywhere and leaks open forever
      // unless we go back and close it once it finally does resolve.
      let connectPromise: Promise<any> | null = null;

      try {
        if (!relay) {
          temporary = true;
          if (!(nostrTools as any).relayInit) return;
          // relayInit only builds the object; nothing is open until connect()
          // is called. Without that the query below waited out its own
          // timeout and returned nothing — which is what this whole path had
          // been quietly doing.
          relay = (nostrTools as any).relayInit(url);
          connectPromise = relay.connect();
          await Promise.race([
            connectPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000))
          ]);
        }

        const queryPromise = relay.querySync ? relay.querySync(filters)
          : relay.query ? relay.query(filters)
          : relay.list ? relay.list(filters)
          : Promise.resolve([]);

        const relayEvents: NostrEventSigned[] = await Promise.race([
          queryPromise,
          new Promise<NostrEventSigned[]>(resolve => setTimeout(() => resolve([]), 4000))
        ]);

        relayEvents.forEach(event => {
          if (!events.has(event.id)) events.set(event.id, event);
        });
      } catch (error) {
        console.warn(`[Relay] Outbox lookup failed for ${url}:`, error);
        if (temporary && relay?.close) {
          // A connection that arrives after we gave up still has to be closed,
          // or it stays open with nothing referring to it
          connectPromise?.catch(() => { /* never connected — nothing to close */ });
          try { relay.close(); } catch { /* already gone */ }
        }
      } finally {
        if (temporary && relay?.close) {
          try { relay.close(); } catch { /* already closed */ }
        }
      }
    }));

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
   * Whether a relay's underlying socket is actually open right now — reads
   * the live WebSocket readyState instead of our own tracked
   * relayConnectionState, which only ever gets updated by code that
   * explicitly touches it (addRelay, a reconnect attempt). A socket that
   * dies quietly in the background (tab backgrounded, laptop sleep, network
   * drop) never flips that tracked flag, so anything that trusted it alone
   * kept believing a dead relay was still connected — nostr-tools'
   * relayInit relay exposes a `status` getter that's the raw
   * WebSocket.readyState *number* (1 === OPEN), not the string 'connected'
   * the old check here compared against, so it never actually matched.
   */
  private isActuallyConnected(relay: any): boolean {
    return this.getReadyState(relay) === WebSocket.OPEN;
  }

  /**
   * Raw readyState (0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED). Distinct
   * from isActuallyConnected because callers that decide whether to call
   * .connect() need to tell "still connecting" apart from "actually dead"
   * — calling connect() again on a relay that's already mid-connect (e.g.
   * app startup's initial connection racing a click that happens right
   * away) starts a second concurrent connection attempt on the same relay
   * object, which can stomp on the first one instead of helping it.
   */
  private getReadyState(relay: any): number {
    if (relay?.socket) return relay.socket.readyState;
    if (typeof relay?.status === 'number') return relay.status;
    return relay?.status === 'connected' ? WebSocket.OPEN : WebSocket.CLOSED;
  }

  /**
   * Refresh connection status for all relays and reconnect if needed
   */
  async refreshConnectionStatus(): Promise<void> {
    console.log(`[Status] Refreshing connection status for ${this.relays.size} relays`);

    for (const [url, relay] of this.relays) {
      try {
        const currentStatus = this.isActuallyConnected(relay);
        this.relayConnectionState.set(url, currentStatus);
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
            this.relayConnectionState.set(url, this.isActuallyConnected(relay));
            // A fresh socket doesn't carry over subscriptions issued on
            // the old one — reattach every active live subscription now
            this.applyActiveSubscriptions(url, relay);
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
      const isConnected = this.isActuallyConnected(relay);
      this.relayConnectionState.set(url, isConnected);
      status.set(url, isConnected);
      console.log(`[Status] ${url}: ${isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}`);
    }
    return status;
  }
}

// Default relay list — free relays that reliably answer queries.
// Dropped: relay.nostr.band (unreachable — reconfirmed by direct WebSocket
// probe), relay.snort.social (returns no data), relayable.org (unreachable),
// relay.nostr.bg (connection error), nostr.wine (paid). purplepag.es
// specializes in profile metadata. relay.primal.net, relay.fountain.fm and
// relay.divine.video are in zap.stream's own default relay set
// (github.com/v0l/zap.stream) — that's where it actually publishes NIP-53
// live events. "relay.zap.stream" (used here previously) doesn't exist as a
// domain — a wrong guess, not a real zap.stream relay. eden.nostr.land,
// offchain.pub, nostr21.com, relay.mostr.pub and nostr.oxtr.dev were all
// probed directly (WebSocket connect + REQ round-trip) and added for
// broader, more redundant coverage.
/** What a relay says about itself in its NIP-11 document */
export interface RelayCapabilities {
  readable: boolean;
  writable: boolean;
  paid: boolean;
  paymentRequired: boolean;
  authRequired: boolean;
  restrictedWrites: boolean;
  paymentsUrl: string;
  feeSummary: string;
  /** Why writes will fail, when they will — shown next to the badge */
  writeBlockedReason?: string;
  name: string;
  description?: string;
}

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://relay.fountain.fm',
  'wss://relay.divine.video',
  'wss://nostr-pub.wellorder.net',
  'wss://eden.nostr.land',
  'wss://offchain.pub',
  'wss://nostr21.com',
  'wss://relay.mostr.pub',
  'wss://nostr.oxtr.dev'
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
