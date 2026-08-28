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
  /** NIP-30 shortcode → picture, from the metadata event's `emoji` tags */
  emojis?: Record<string, string>;
}

export interface EventWithMetadata extends NostrEventSigned {
  relayUrl?: string;
  profileMetadata?: UserProfile;
}

// Event kinds
export const EVENT_KINDS = {
  TEXT_NOTE: 1,
  /**
   * NIP-22 comment. A reply to a note, written as its own kind rather than
   * as another kind 1 carrying 'e' tags — Amethyst writes every reply this
   * way now, so a client that only knows kind 1 sees those conversations as
   * empty. The parent is in lowercase 'e'/'k'/'p', the thread's root in
   * uppercase 'E'/'K'/'P'.
   */
  COMMENT: 1111,
  SET_METADATA: 0,
  RECOMMENDED_RELAY: 2,
  CONTACTS: 3,
  ENCRYPTED_DM: 4,
  DELETION: 5,
  REPOST: 6,
  REACTION: 7,
  BADGE_AWARD: 8,
  SEAL: 13,
  CHAT_MESSAGE: 14,
  ZAP_REQUEST: 9734,
  ZAP_RECEIPT: 9735,
  GIFT_WRAP: 1059,
  CHANNEL_CREATE: 40,
  CHANNEL_METADATA: 41,
  CHANNEL_MESSAGE: 42,
  CHANNEL_HIDE_MESSAGE: 43,
  CHANNEL_MUTE_USER: 44,
  // NIP-51 mute list — the accounts you've blocked, as public 'p' tags
  MUTE_LIST: 10000,
  /**
   * NIP-51 bookmarks (kind 10003) — notes kept to come back to. Public 'e'
   * tags, like the mute list: a bookmark only this client can read is one
   * that vanishes the moment its owner opens another.
   */
  BOOKMARKS: 10003,
  LONG_FORM: 30023,
  APP_SPECIFIC_DATA: 30078,
  POLL: 1068,
  POLL_RESPONSE: 1018,
  BLOSSOM_AUTH: 24242,
  LIVE_EVENT: 30311,
  LIVE_CHAT_MESSAGE: 1311,
  /** NIP-53 room presence: "I am watching this right now" */
  LIVE_PRESENCE: 10312,
  /** NIP-51 people set — used here for a stream's own list of muted accounts */
  PEOPLE_SET: 30000,

  // NIP-29 relay-based groups. The relay is the server: it holds the group,
  // decides who is in it, and every event carries an 'h' tag naming which
  // group it belongs to.
  /** A message in a group's chat */
  GROUP_CHAT: 9,
  /** A thread started in a group, as opposed to a line of chat */
  GROUP_THREAD: 11,
  /** Asking the relay to be let in */
  GROUP_JOIN_REQUEST: 9021,
  /** Making a group, and saying what it is */
  GROUP_CREATE: 9007,
  GROUP_EDIT_METADATA: 9002,
  /** Telling it you are leaving */
  GROUP_LEAVE_REQUEST: 9022,
  /** The group itself: name, picture, whether it is public and open */
  GROUP_METADATA: 39000,
  /** Who runs it */
  GROUP_ADMINS: 39001,
  /** Who is in it */
  GROUP_MEMBERS: 39002,
  /** What the group calls its ranks, and what each one means */
  GROUP_ROLES: 39003,
  /** NIP-42: proving to a relay who you are, which group relays ask for */
  CLIENT_AUTH: 22242,
  /** NIP-51: the groups this account is in, so they follow it between apps */
  GROUP_LIST: 10009
};

// Common hashtags
export interface NostrTag {
  name: string;
  value: string;
}
