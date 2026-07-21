import { CredentialManager } from '../nostr/crypto';

export interface BlossomServerConfig {
  url: string;
  enabled: boolean;
}

// A couple of known public Blossom servers so uploads work before the user
// configures anything of their own
const DEFAULT_SERVERS: BlossomServerConfig[] = [
  { url: 'https://blossom.primal.net', enabled: true },
  { url: 'https://nostr.download', enabled: true }
];

// Personal preference like custom feeds — kept per-pubkey so switching
// identities on this browser doesn't mix one account's servers into another's
const blossomServersKey = (): string => {
  const pubkey = CredentialManager.getPublicKey();
  return pubkey ? `nostr_blossom_servers_${pubkey}` : 'nostr_blossom_servers';
};

export const loadBlossomServers = (): BlossomServerConfig[] => {
  try {
    const raw = localStorage.getItem(blossomServersKey());
    return raw ? JSON.parse(raw) : DEFAULT_SERVERS;
  } catch {
    return DEFAULT_SERVERS;
  }
};

export const saveBlossomServers = (servers: BlossomServerConfig[]): void => {
  try {
    localStorage.setItem(blossomServersKey(), JSON.stringify(servers));
  } catch {
    // storage full or unavailable — best effort
  }
};

export const addBlossomServer = (url: string): BlossomServerConfig[] => {
  const normalized = url.trim().replace(/\/+$/, '');
  const current = loadBlossomServers();
  if (!normalized || current.some(s => s.url === normalized)) return current;
  const updated = [...current, { url: normalized, enabled: true }];
  saveBlossomServers(updated);
  return updated;
};

export const removeBlossomServer = (url: string): BlossomServerConfig[] => {
  const updated = loadBlossomServers().filter(s => s.url !== url);
  saveBlossomServers(updated);
  return updated;
};

export const toggleBlossomServer = (url: string): BlossomServerConfig[] => {
  const updated = loadBlossomServers().map(s => (s.url === url ? { ...s, enabled: !s.enabled } : s));
  saveBlossomServers(updated);
  return updated;
};
