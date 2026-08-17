import * as nostrTools from 'nostr-tools';
import { NostrEvent, NostrEventSigned, NostrFilter, EVENT_KINDS } from '../types';
import { NostrCrypto, CredentialManager, ExtensionManager } from './crypto';
import { getRelayPool } from './relay';

export interface DirectMessage {
  id: string;
  senderPubkey: string;
  /** The other party in the conversation, from our point of view */
  otherPubkey: string;
  content: string;
  createdAt: number;
  replyTo?: string;
  isOwn: boolean;
}

export interface Conversation {
  pubkey: string;
  lastMessage: DirectMessage;
}

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

  private static buildRumor(senderPubkey: string, recipientPubkey: string, content: string, replyTo?: string): NostrEventSigned {
    const tags: string[][] = [['p', recipientPubkey]];
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

  /** Seal a rumor for `targetPubkey` and wrap it in a gift wrap addressed to them */
  private static async sealAndWrap(rumor: NostrEventSigned, targetPubkey: string): Promise<NostrEventSigned> {
    const sealContent = await this.nip44Encrypt(JSON.stringify(rumor), targetPubkey);
    const seal = await this.signAsSelf(
      { kind: EVENT_KINDS.SEAL, content: sealContent, tags: [] },
      this.randomPastTimestamp()
    );

    const ephemeralPrivkey = NostrCrypto.generatePrivateKey();
    const wrapContent = NostrCrypto.encryptNip44(JSON.stringify(seal), ephemeralPrivkey, targetPubkey);

    return NostrCrypto.signEvent(
      { kind: EVENT_KINDS.GIFT_WRAP, content: wrapContent, tags: [['p', targetPubkey]] },
      ephemeralPrivkey,
      this.randomPastTimestamp()
    );
  }

  /**
   * Send a private message. Publishes two gift wraps of the same rumor —
   * one the recipient can decrypt, one only we can decrypt — so the
   * conversation shows up in our own history too (relays never see the
   * rumor itself, so without this self-copy we couldn't read our own sent
   * messages back).
   */
  static async sendDirectMessage(recipientPubkey: string, content: string, replyTo?: string): Promise<boolean> {
    if (!CredentialManager.canSign()) {
      throw new Error('No signing method available — log in again');
    }
    // NIP-55 signers encrypt through their own intents (nip44_encrypt /
    // nip44_decrypt), which this client doesn't implement yet — so say so
    // instead of building a message nothing can read
    if (CredentialManager.isAmberMode()) {
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

    const senderPubkey = CredentialManager.getPublicKey();
    if (!senderPubkey) throw new Error('Public key not found');

    const rumor = this.buildRumor(senderPubkey, recipientPubkey, content, replyTo);

    const [wrapForRecipient, wrapForSelf] = await Promise.all([
      this.sealAndWrap(rumor, recipientPubkey),
      this.sealAndWrap(rumor, senderPubkey)
    ]);

    const relayPool = getRelayPool();
    const [recipientResults] = await Promise.all([
      relayPool.publishEvent(wrapForRecipient),
      relayPool.publishEvent(wrapForSelf)
    ]);

    if (!Array.from(recipientResults.values()).some(Boolean)) {
      throw new Error('No relay accepted the message');
    }
    return true;
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
      const otherPubkey = isOwn
        ? rumor.tags.find(t => t[0] === 'p' && t[1] !== ownPubkey)?.[1] || ownPubkey
        : seal.pubkey;

      return {
        id: rumor.id,
        senderPubkey: seal.pubkey,
        otherPubkey,
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

  /** Group a flat message list into per-contact conversations, newest first */
  static groupConversations(messages: DirectMessage[]): Conversation[] {
    const byContact = new Map<string, DirectMessage>();
    for (const message of messages) {
      const existing = byContact.get(message.otherPubkey);
      if (!existing || message.createdAt > existing.createdAt) {
        byContact.set(message.otherPubkey, message);
      }
    }

    return Array.from(byContact.entries())
      .map(([pubkey, lastMessage]) => ({ pubkey, lastMessage }))
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
      !c.lastMessage.isOwn && c.lastMessage.createdAt > this.getLastSeen(ownPubkey, c.pubkey)
    ).length;
  }
}
