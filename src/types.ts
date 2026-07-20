// Core NOSTR types based on NIP-01

export interface NostrEvent {
  id?: string;
  pubkey?: string;
  created_at?: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

export type NostrEventSigned = Required<NostrEvent>;

export interface NostrFilter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

export interface NostrSubscription {
  id: string;
  filters: NostrFilter[];
  callback: (event: NostrEventSigned) => void;
  eoseCallback?: () => void;
}

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export interface UserProfile {
  pubkey: string;
  name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  website?: string;
  banner?: string;
  display_name?: string;
  lud16?: string;
}

export interface EventWithMetadata extends NostrEventSigned {
  relayUrl?: string;
  profileMetadata?: UserProfile;
}

// Event kinds
export const EVENT_KINDS = {
  TEXT_NOTE: 1,
  SET_METADATA: 0,
  RECOMMENDED_RELAY: 2,
  CONTACTS: 3,
  ENCRYPTED_DM: 4,
  DELETION: 5,
  REPOST: 6,
  REACTION: 7,
  BADGE_AWARD: 8,
  ZAP_REQUEST: 9734,
  ZAP_RECEIPT: 9735,
  CHANNEL_CREATE: 40,
  CHANNEL_METADATA: 41,
  CHANNEL_MESSAGE: 42,
  CHANNEL_HIDE_MESSAGE: 43,
  CHANNEL_MUTE_USER: 44,
  LONG_FORM: 30023,
  APP_SPECIFIC_DATA: 30078
};

// Common hashtags
export interface NostrTag {
  name: string;
  value: string;
}
