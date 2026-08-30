import * as nostrTools from 'nostr-tools';
import { NostrEvent, NostrEventSigned, NostrFilter, EVENT_KINDS } from '../types';
import { NostrCrypto, CredentialManager, ExtensionManager } from './crypto';
import { getRelayPool } from './relay';

export interface DirectMessage {
  id: string;
  senderPubkey: string;
  /** The other party in the conversation, from our point of view */
  otherPubkey: string;
  /**
   * Everyone in the conversation except us, sorted. One name for a private
   * message, several for a group — the same message shape either way.
   */
  participants: string[];
  /** Those participants as one string, which is what a conversation is known by */
  key: string;
  /** What the group calls itself, where it calls itself anything */
  subject?: string;
  content: string;
  createdAt: number;
  replyTo?: string;
  isOwn: boolean;
}

export interface Conversation {
  /** The participants joined together — a person's key for a private message */
  key: string;
  participants: string[];
  subject?: string;
  lastMessage: DirectMessage;
}

/**
 * A conversation is known by who is in it, so the same people always land in
 * the same thread whichever of them writes.
 */
export const conversationKey = (participants: string[]): string =>
  Array.from(new Set(participants)).sort().join(',');

/**
 * Every message is sealed and wrapped once per person, so a room of thirty
 * is thirty publishes for every line typed. This is where that stops being
 * reasonable.
 */
export const MAX_GROUP_MEMBERS = 25;

/**
 * NIP-17 private direct messages: an unsigned kind-14 "rumor" (the actual
 * message) is wrapped in a kind-13 "seal" (signed by the real sender, NIP-44
 * encrypted) which is itself wrapped in a kind-1059 "gift wrap" (signed by a
 * throwaway one-time key, NIP-44 encrypted again). Relays only ever see the
 * gift wrap, so — unlike NIP-04 — who's talking to whom stays private.
 */
export class DirectMessageCore {
  /**
   * NIP-59 recommends randomizing seal/wrap timestamps (up to ~2 days in
   * the past) so relays and observers can't use them to time real sends.
   */
  private static randomPastTimestamp(): number {
    const now = Math.floor(Date.now() / 1000);
    return now - Math.floor(Math.random() * 2 * 24 * 60 * 60);
  }

  private static async nip44Encrypt(plaintext: string, otherPubkey: string): Promise<string> {
    if (CredentialManager.isExtensionMode()) {
      return ExtensionManager.encryptNip44(otherPubkey, plaintext);
    }
    const privkey = CredentialManager.getPrivateKey();
    if (!privkey) throw new Error('Private key not found');
    return NostrCrypto.encryptNip44(plaintext, privkey, otherPubkey);
  }

  private static async nip44Decrypt(ciphertext: string, otherPubkey: string): Promise<string> {
    if (CredentialManager.isExtensionMode()) {
      return ExtensionManager.decryptNip44(otherPubkey, ciphertext);
    }
    const privkey = CredentialManager.getPrivateKey();
    if (!privkey) throw new Error('Private key not found');
    return NostrCrypto.decryptNip44(ciphertext, privkey, otherPubkey);
  }

  /** Sign as our real identity (extension or local key) — used for the seal */
  private static async signAsSelf(event: NostrEvent, createdAt: number): Promise<NostrEventSigned> {
    if (CredentialManager.isExtensionMode()) {
      const template = { kind: event.kind, created_at: createdAt, tags: event.tags, content: event.content };
      const signed = await ExtensionManager.signEvent(template);
      if (!signed?.id || !signed?.sig) {
        throw new Error('Extension did not sign the message — check the extension popup and its site permissions');
      }
      return signed as NostrEventSigned;
    }
    const privkey = CredentialManager.getPrivateKey();
    if (!privkey) throw new Error('Private key not found');
    return NostrCrypto.signEvent(event, privkey, createdAt);
  }

  private static buildRumor(
    senderPubkey: string,
    recipients: string[],
    content: string,
    replyTo?: string,
    subject?: string
  ): NostrEventSigned {
    // Everyone the message is for is named in it, so whoever opens it can
    // see the whole room rather than only the person who wrote to them.
    // The sender is not named: the seal around this is signed by them.
    const tags: string[][] = recipients.map(pubkey => ['p', pubkey]);
    if (subject) tags.push(['subject', subject]);
    if (replyTo) tags.push(['e', replyTo]);

    const template: any = {
      kind: EVENT_KINDS.CHAT_MESSAGE,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
      pubkey: senderPubkey
    };
    // The rumor is intentionally left unsigned — its authenticity comes
    // from the seal that wraps it, which IS signed by the sender.
    template.id = nostrTools.getEventHash(template);
    template.sig = '';
    return template as NostrEventSigned;
  }

  /**
   * Seal a rumor for `targetPubkey` and wrap it in a gift wrap addressed to
   * them. Public because an invitation to an encrypted community travels the
   * same way a private message does, and there should be one implementation
   * of that, not two.
   */
  static async sealAndWrap(
    rumor: NostrEventSigned,
    targetPubkey: string,
    /**
     * Tags for the wrap itself. A wrap normally says nothing but who it is
     * for; a Concord invite deliberately adds `["k","3313"]` so a recipient
     * can look up their invitations without decrypting every gift wrap ever
     * addressed to them.
     */
    extraWrapTags: string[][] = []
  ): Promise<NostrEventSigned> {
    const sealContent = await this.nip44Encrypt(JSON.stringify(rumor), targetPubkey);
    const seal = await this.signAsSelf(
      { kind: EVENT_KINDS.SEAL, content: sealContent, tags: [] },
      this.randomPastTimestamp()
    );

    const ephemeralPrivkey = NostrCrypto.generatePrivateKey();
    const wrapContent = NostrCrypto.encryptNip44(JSON.stringify(seal), ephemeralPrivkey, targetPubkey);

    return NostrCrypto.signEvent(
      { kind: EVENT_KINDS.GIFT_WRAP, content: wrapContent, tags: [['p', targetPubkey], ...extraWrapTags] },
      ephemeralPrivkey,
      this.randomPastTimestamp()
    );
  }

  /** Why this session cannot write an encrypted message, if it cannot */
  private static refuseToEncrypt(): void {
    if (!CredentialManager.canSign()) {
      throw new Error('No signing method available — log in again');
    }
    // A remote signer encrypts through its own nip44_encrypt/nip44_decrypt
    // calls, which this client doesn't implement yet — so say so instead of
    // building a message nothing can read
    if (CredentialManager.isBunkerMode()) {
      throw new Error(
        'Private messages need encryption from the signer app, which this client does not support yet. ' +
        'Posting, likes and zaps work; for DMs use a stored key or a NIP-44 capable extension.'
      );
    }
    if (CredentialManager.isExtensionMode() && !ExtensionManager.hasNip44()) {
      throw new Error(
        'Your NOSTR extension does not support NIP-44 encryption, required for private messages.'
      );
    }
  }

  /**
   * Send one message to everyone in a conversation — one person or twenty.
   *
   * The rumor is sealed and wrapped separately for each of them, and once
   * more for us: relays never see the rumor, so without our own copy we
   * could not read back what we had said. Nobody hosts this room and no
   * relay knows it exists — what a relay holds is a pile of gift wraps
   * addressed to one key each.
   *
   * A member added later sees nothing that came before, and the room they
   * join is a different room to the one that ran without them: a
   * conversation is known by who is in it, and that is the whole of it.
   * NIP-17 has no membership event to change.
   */
  static async sendGroupMessage(
    members: string[],
    content: string,
    subject?: string,
    replyTo?: string
  ): Promise<boolean> {
    this.refuseToEncrypt();

    const senderPubkey = CredentialManager.getPublicKey();
    if (!senderPubkey) throw new Error('Public key not found');

    const recipients = Array.from(new Set(members)).filter(pubkey => pubkey !== senderPubkey);
    if (recipients.length === 0) throw new Error('A message needs somebody to go to');
    if (recipients.length > MAX_GROUP_MEMBERS) {
      throw new Error(`A group here holds ${MAX_GROUP_MEMBERS} people — every message is sealed once for each of them`);
    }

    const rumor = this.buildRumor(senderPubkey, recipients, content, replyTo, subject);

    const wraps = await Promise.all(
      [...recipients, senderPubkey].map(target => this.sealAndWrap(rumor, target))
    );

    const relayPool = getRelayPool();
    const results = await Promise.all(wraps.map(wrap => relayPool.publishEvent(wrap)));

    // Our own copy landing is not the message arriving anywhere, so the
    // wraps for the others are what says whether it went
    const forOthers = results.slice(0, recipients.length);
    if (!forOthers.some(result => Array.from(result.values()).some(Boolean))) {
      throw new Error('No relay accepted the message');
    }
    return true;
  }

  /** One person, which is a conversation of two */
  static async sendDirectMessage(recipientPubkey: string, content: string, replyTo?: string): Promise<boolean> {
    return this.sendGroupMessage([recipientPubkey], content, undefined, replyTo);
  }

  /** Unwrap and decrypt a single gift wrap. Returns null if it's not ours, malformed, or spoofed. */
  private static async unwrap(wrap: NostrEventSigned, ownPubkey: string): Promise<DirectMessage | null> {
    try {
      const sealJson = await this.nip44Decrypt(wrap.content, wrap.pubkey);
      const seal = JSON.parse(sealJson) as NostrEventSigned;
      if (seal.kind !== EVENT_KINDS.SEAL) return null;

      // The seal must genuinely be signed by the pubkey it claims
      const verifySig = (nostrTools as any).verifySignature || (nostrTools as any).verifyEvent;
      if (typeof verifySig === 'function' && !verifySig(seal)) return null;

      const rumorJson = await this.nip44Decrypt(seal.content, seal.pubkey);
      const rumor = JSON.parse(rumorJson) as NostrEventSigned;

      // The rumor itself is unsigned — only trust it because the seal
      // wrapping it (which IS signed) claims the same author
      if (rumor.pubkey !== seal.pubkey) return null;
      if (rumor.kind !== EVENT_KINDS.CHAT_MESSAGE) return null;

      const isOwn = seal.pubkey === ownPubkey;
      // Who is in this conversation: everyone the message names, and whoever
      // wrote it — minus ourselves, since a conversation is the people on
      // the other side of it. One name for a private message, several for a
      // group, and the same set however many of them write.
      const named = rumor.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1]);
      const participants = Array.from(new Set([...named, seal.pubkey]))
        .filter(pubkey => pubkey !== ownPubkey)
        .sort();

      return {
        id: rumor.id,
        senderPubkey: seal.pubkey,
        // A message we sent to ourselves alone still belongs somewhere
        otherPubkey: participants[0] || ownPubkey,
        participants: participants.length > 0 ? participants : [ownPubkey],
        key: conversationKey(participants.length > 0 ? participants : [ownPubkey]),
        subject: rumor.tags.find(t => t[0] === 'subject')?.[1],
        content: rumor.content,
        createdAt: rumor.created_at || 0,
        replyTo: rumor.tags.find(t => t[0] === 'e')?.[1],
        isOwn
      };
    } catch {
      // Not addressed to us with a key we hold, or malformed — skip it
      return null;
    }
  }

  /**
   * Fetch and decrypt all private messages addressed to us, deduplicated
   * (the recipient's and our own copy of the same rumor share an id).
   */
  static async fetchMessages(ownPubkey: string, limit: number = 500): Promise<DirectMessage[]> {
    const filters: NostrFilter[] = [
      { kinds: [EVENT_KINDS.GIFT_WRAP], '#p': [ownPubkey], limit }
    ];

    try {
      const relayPool = getRelayPool();
      const wraps = await relayPool.fetchEvents(filters);

      const results = await Promise.all(wraps.map(wrap => this.unwrap(wrap, ownPubkey)));

      const byId = new Map<string, DirectMessage>();
      for (const message of results) {
        if (message) byId.set(message.id, message);
      }

      return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
    } catch (error) {
      console.error('Failed to fetch direct messages:', error);
      return [];
    }
  }

  /** A flat message list as conversations — by who is in them — newest first */
  static groupConversations(messages: DirectMessage[]): Conversation[] {
    const byRoom = new Map<string, DirectMessage>();
    for (const message of messages) {
      const existing = byRoom.get(message.key);
      if (!existing || message.createdAt > existing.createdAt) {
        byRoom.set(message.key, message);
      }
    }

    return Array.from(byRoom.values())
      .map(lastMessage => ({
        key: lastMessage.key,
        participants: lastMessage.participants,
        // The name the room was last given, so renaming it is just saying so
        subject: lastMessage.subject,
        lastMessage
      }))
      .sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt);
  }
}

/**
 * Tracks the last-seen message timestamp per conversation in localStorage
 * so unread indicators survive reloads.
 */
export class DirectMessageStore {
  private static readonly PREFIX = 'nostr_dm_seen_';

  private static key(ownPubkey: string, otherPubkey: string): string {
    return `${this.PREFIX}${ownPubkey}_${otherPubkey}`;
  }

  static getLastSeen(ownPubkey: string, otherPubkey: string): number {
    try {
      const raw = localStorage.getItem(this.key(ownPubkey, otherPubkey));
      return raw ? parseInt(raw, 10) : 0;
    } catch {
      return 0;
    }
  }

  static setLastSeen(ownPubkey: string, otherPubkey: string, timestamp: number): void {
    try {
      localStorage.setItem(this.key(ownPubkey, otherPubkey), String(timestamp));
    } catch {
      // Best effort — a full quota just means the badge may re-show later
    }
  }

  static countUnread(ownPubkey: string, conversations: Conversation[]): number {
    return conversations.filter(c =>
      !c.lastMessage.isOwn && c.lastMessage.createdAt > this.getLastSeen(ownPubkey, c.key)
    ).length;
  }
}
