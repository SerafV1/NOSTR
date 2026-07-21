import { CredentialManager } from '../nostr/crypto';

// Custom (hashtag) feeds are a personal shortcut list, so they're kept
// per-pubkey — otherwise switching identities on this browser would show
// one account's saved feeds to another.
const customFeedsKey = (): string => {
  const pubkey = CredentialManager.getPublicKey();
  return pubkey ? `nostr_custom_feeds_${pubkey}` : 'nostr_custom_feeds';
};

export const loadCustomFeeds = (): string[] => {
  try {
    const raw = localStorage.getItem(customFeedsKey());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

export const saveCustomFeeds = (feeds: string[]): void => {
  try {
    localStorage.setItem(customFeedsKey(), JSON.stringify(feeds));
  } catch {
    // storage full or unavailable — best effort
  }
};

export const addCustomFeed = (tag: string): string[] => {
  const normalized = tag.trim().replace(/^#/, '').toLowerCase();
  const current = loadCustomFeeds();
  if (!normalized || current.includes(normalized)) return current;
  const updated = [...current, normalized];
  saveCustomFeeds(updated);
  return updated;
};
