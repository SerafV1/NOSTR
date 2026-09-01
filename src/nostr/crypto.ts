import * as nostrTools from 'nostr-tools';
// The NIP-44 shipped with the pinned nostr-tools is an early draft: it
// derives a different key, so what it writes reads as "invalid MAC" in every
// other client and theirs does the same here — proven by cross-decrypting
// both ways. Private messages are only private if somebody else can read
// them, so they go through the modern implementation, which is already in
// the tree for the same reason (see bunker.ts).
import { nip44 as modernNip44 } from 'nostr-tools-v2';
import { NostrEvent, NostrEventSigned } from '../types';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/.{1,2}/g) || []).map(byte => parseInt(byte, 16)));

export class NostrCrypto {
  /**
   * Generate a new random private key
   */
  static generatePrivateKey(): string {
    try {
      // Try new API first
      if ((nostrTools as any).generateSecretKey) {
        return (nostrTools as any).generateSecretKey();
      }
      // Fallback to generating random hex
      return Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } catch (error) {
      // Fallback: generate random 32 bytes
      return Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }
  }

  /**
   * Normalize a private key to 64-char hex — accepts hex or nsec1 bech32.
   * Returns null if the key is in neither format.
   */
  static normalizePrivateKey(key: string): string | null {
    const trimmed = key.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (trimmed.toLowerCase().startsWith('nsec1')) {
      try {
        const decoded = (nostrTools as any).nip19.decode(trimmed);
        if (decoded?.type === 'nsec' && typeof decoded.data === 'string') {
          return decoded.data;
        }
      } catch (error) {
        console.error('Failed to decode nsec key:', error);
      }
    }
    return null;
  }

  /**
   * Get public key from private key
   */
  static getPublicKey(privateKey: string): string {
    try {
      const normalized = this.normalizePrivateKey(privateKey);
      if (!normalized) throw new Error('Private key is not valid hex or nsec format');
      return nostrTools.getPublicKey(normalized);
    } catch (error) {
      console.error('Error getting public key:', error);
      throw error;
    }
  }

  /**
   * Create and sign an event. createdAt defaults to now — callers that need
   * a specific timestamp (e.g. NIP-59 gift wraps, which randomize it to
   * avoid leaking send time) can override it.
   */
  static signEvent(event: NostrEvent, privateKey: string, createdAt?: number): NostrEventSigned {
    const normalizedKey = this.normalizePrivateKey(privateKey);
    if (!normalizedKey) throw new Error('Private key is not valid hex or nsec format');
    privateKey = normalizedKey;

    const pubkey = this.getPublicKey(privateKey);

    const eventTemplate: any = {
      kind: event.kind,
      created_at: createdAt ?? Math.floor(Date.now() / 1000),
      tags: event.tags || [],
      content: event.content,
      pubkey
    };

    try {
      const nt = nostrTools as any;

      // nostr-tools v1 API
      if (nt.finishEvent) {
        return nt.finishEvent(eventTemplate, privateKey) as NostrEventSigned;
      }
      // nostr-tools v2 API
      if (nt.finalizeEvent) {
        return nt.finalizeEvent(eventTemplate, privateKey) as NostrEventSigned;
      }
      // Manual fallback: compute id and signature directly
      eventTemplate.id = nt.getEventHash(eventTemplate);
      eventTemplate.sig = nt.getSignature(eventTemplate, privateKey);
      return eventTemplate as NostrEventSigned;
    } catch (error) {
      console.error('Error signing event:', error);
      throw error;
    }
  }

  /**
   * Verify an event signature
   */
  static verifyEvent(event: NostrEventSigned): boolean {
    try {
      if ((nostrTools as any).verifyEvent) {
        return (nostrTools as any).verifyEvent(event as any);
      } else {
        // Fallback: basic verification
        return !!event.sig && !!event.id;
      }
    } catch {
      return false;
    }
  }

  /**
   * Encrypt message for a recipient (NIP-04)
   */
  static async encryptMessage(message: string, publicKey: string, privateKey: string): Promise<string> {
    try {
      if (nostrTools.nip04 && nostrTools.nip04.encrypt) {
        return await nostrTools.nip04.encrypt(privateKey as `0x${string}`, publicKey, message);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Decrypt message from a sender (NIP-04)
   */
  static async decryptMessage(ciphertext: string, publicKey: string, privateKey: string): Promise<string> {
    try {
      if (nostrTools.nip04 && nostrTools.nip04.decrypt) {
        return await nostrTools.nip04.decrypt(privateKey as `0x${string}`, publicKey, ciphertext);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Derive the NIP-44 conversation key (ECDH shared secret) between our
   * private key and another party's public key. Symmetric: deriving with
   * (privA, pubB) yields the same key as (privB, pubA), which is what lets
   * both sides of a conversation — and a sender re-reading their own sent
   * messages — decrypt with just their own key.
   */
  static getConversationKey(privateKey: string, publicKey: string): Uint8Array {
    const normalized = this.normalizePrivateKey(privateKey);
    if (!normalized) throw new Error('Private key is not valid hex or nsec format');
    return modernNip44.v2.utils.getConversationKey(hexToBytes(normalized), publicKey);
  }

  /** The key the early draft derived, kept only for reading what it wrote */
  private static draftConversationKey(privateKey: string, publicKey: string): Uint8Array {
    const normalized = this.normalizePrivateKey(privateKey);
    if (!normalized) throw new Error('Private key is not valid hex or nsec format');
    return (nostrTools as any).nip44.utils.v2.getConversationKey(normalized, publicKey);
  }

  /**
   * Encrypt a message for a recipient (NIP-44) — used for NIP-17 private
   * direct messages instead of the legacy NIP-04 scheme above.
   */
  static encryptNip44(message: string, privateKey: string, publicKey: string): string {
    return modernNip44.v2.encrypt(message, this.getConversationKey(privateKey, publicKey));
  }

  /**
   * Decrypt a message from a sender (NIP-44).
   *
   * Anything this app sent before the draft was swapped out is still on the
   * relays and still someone's conversation, so that key is tried after the
   * real one rather than leaving those messages unreadable.
   */
  static decryptNip44(ciphertext: string, privateKey: string, publicKey: string): string {
    try {
      return modernNip44.v2.decrypt(ciphertext, this.getConversationKey(privateKey, publicKey));
    } catch (error) {
      try {
        return (nostrTools as any).nip44.decrypt(
          this.draftConversationKey(privateKey, publicKey),
          ciphertext
        );
      } catch {
        throw error;
      }
    }
  }

  /**
   * Format public key to npub format
   */
  static npubEncode(pubkey: string): string {
    try {
      return (nostrTools as any).nip19.npubEncode(pubkey);
    } catch {
      return '';
    }
  }

  /**
   * Format private key to nsec format
   */
  static nsecEncode(privateKey: string): string {
    try {
      return (nostrTools as any).nip19.nsecEncode(privateKey);
    } catch {
      return '';
    }
  }

  /**
   * Decode npub to pubkey
   */
  static npubDecode(npub: string): string {
    try {
      const decoded = (nostrTools as any).nip19.decode(npub);
      return decoded.type === 'npub' ? decoded.data : '';
    } catch {
      return '';
    }
  }

  /**
   * Decode nsec to private key
   */
  static nsecDecode(nsec: string): string {
    try {
      const decoded = (nostrTools as any).nip19.decode(nsec);
      return decoded.type === 'nsec' ? decoded.data : '';
    } catch {
      return '';
    }
  }

  /**
   * Get event ID
   */
  static getEventId(event: NostrEvent): string {
    const eventTemplate = {
      kind: event.kind,
      created_at: event.created_at || Math.floor(Date.now() / 1000),
      tags: event.tags || [],
      content: event.content,
      pubkey: event.pubkey || ''
    };
    
    try {
      if (nostrTools.getEventHash) {
        return nostrTools.getEventHash(eventTemplate as any);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Create URL for note (nip19)
   */
  static encodeNote(noteId: string): string {
    try {
      return (nostrTools as any).nip19.noteEncode(noteId);
    } catch {
      return '';
    }
  }

  /**
   * Decode note from nip19
   */
  static decodeNote(note: string): string | null {
    try {
      const decoded = (nostrTools as any).nip19.decode(note);
      return decoded.type === 'note' && typeof decoded.data === 'string' ? decoded.data : null;
    } catch {
      return null;
    }
  }
}

/**
 * Store credentials securely in localStorage
 */
export class CredentialManager {
  private static readonly KEY_PREFIX = 'nostr_';
  private static readonly EXTENSION_MODE_KEY = 'nostr_extension_mode';

  static storePrivateKey(privateKey: string): void {
    // Always store as hex so signing never sees an nsec-format key
    const normalized = NostrCrypto.normalizePrivateKey(privateKey) ?? privateKey;
    localStorage.setItem(this.KEY_PREFIX + 'privkey', normalized);
    localStorage.removeItem(this.EXTENSION_MODE_KEY);
  }

  static getPrivateKey(): string | null {
    const stored = localStorage.getItem(this.KEY_PREFIX + 'privkey');
    if (!stored) return null;
    // Legacy sessions may have stored an nsec key — normalize on read
    return NostrCrypto.normalizePrivateKey(stored) ?? stored;
  }

  static storePublicKey(publicKey: string): void {
    localStorage.setItem(this.KEY_PREFIX + 'pubkey', publicKey);
  }

  static getPublicKey(): string | null {
    return localStorage.getItem(this.KEY_PREFIX + 'pubkey');
  }

  // NIP-46: a signer reachable over a relay rather than through the OS
  private static readonly BUNKER_MODE_KEY = 'nostr_bunker_mode';

  static setBunkerMode(enabled: boolean): void {
    if (enabled) {
      localStorage.setItem(this.BUNKER_MODE_KEY, 'true');
      localStorage.removeItem(this.EXTENSION_MODE_KEY);
    } else {
      localStorage.removeItem(this.BUNKER_MODE_KEY);
    }
  }

  static isBunkerMode(): boolean {
    return localStorage.getItem(this.BUNKER_MODE_KEY) === 'true';
  }

  static setExtensionMode(enabled: boolean): void {
    if (enabled) {
      localStorage.setItem(this.EXTENSION_MODE_KEY, 'true');
    } else {
      localStorage.removeItem(this.EXTENSION_MODE_KEY);
    }
  }

  static isExtensionMode(): boolean {
    return localStorage.getItem(this.EXTENSION_MODE_KEY) === 'true';
  }

  static clear(): void {
    localStorage.removeItem(this.KEY_PREFIX + 'privkey');
    localStorage.removeItem(this.KEY_PREFIX + 'pubkey');
    localStorage.removeItem(this.EXTENSION_MODE_KEY);
    localStorage.removeItem(this.BUNKER_MODE_KEY);
  }

  /**
   * Whether this session can produce a signature at all — by holding the key,
   * by talking to an extension, or by handing off to a signer app. Publish
   * paths used to ask "no extension and no key?" directly, which quietly
   * answered "you can't post" for anyone logged in through Amber.
   */
  static canSign(): boolean {
    return this.getPrivateKey() !== null
      || this.isExtensionMode()
      || this.isBunkerMode();
  }

  static isLoggedIn(): boolean {
    return this.getPrivateKey() !== null
      || this.isExtensionMode()
      || this.isBunkerMode();
  }
}

/**
 * NIP-07 Extension support for NOSTR
 */
export interface NostrWindow extends Window {
  nostr?: {
    getPublicKey(): Promise<string>;
    signEvent(event: any): Promise<any>;
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
    nip04?: {
      encrypt?: (pubkey: string, plaintext: string) => Promise<string>;
      decrypt?: (pubkey: string, ciphertext: string) => Promise<string>;
    };
    nip44?: {
      encrypt(pubkey: string, plaintext: string): Promise<string>;
      decrypt(pubkey: string, ciphertext: string): Promise<string>;
    };
  };
}

export class ExtensionManager {
  /**
   * Check if NIP-07 extension is available
   */
  static hasExtension(): boolean {
    return typeof window !== 'undefined' && !!(window as NostrWindow).nostr;
  }

  /**
   * Get public key from extension. Some extensions (nos2x in particular)
   * open their approval prompt as a separate OS window, which certain
   * window managers/browser setups can leave unfocused or hidden — from
   * the page's perspective this looks like the call hanging forever with
   * no popup, error, or rejection. A timeout turns that silent hang into
   * a clear, actionable error instead of leaving the caller stuck.
   */
  static async getPublicKey(timeoutMs: number = 20000): Promise<string | null> {
    try {
      const nostr = (window as NostrWindow).nostr;
      if (!nostr) {
        throw new Error('NOSTR extension not found');
      }
      const pubkey = await Promise.race([
        nostr.getPublicKey(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(
              'Extension did not respond in time — its approval prompt may have opened ' +
              'in a window that lost focus or opened behind the browser. Check for another ' +
              'window/taskbar entry, or if you have multiple NOSTR extensions installed ' +
              '(e.g. Alby + nos2x), disable all but one and try again.'
            )),
            timeoutMs
          )
        )
      ]);
      return pubkey;
    } catch (error) {
      console.error('Failed to get public key from extension:', error);
      throw error;
    }
  }

  /**
   * Login via extension (NIP-07)
   */
  static async loginWithExtension(): Promise<string | null> {
    const pubkey = await this.getPublicKey();
    if (!pubkey) {
      throw new Error('Failed to get public key from extension');
    }

    CredentialManager.storePublicKey(pubkey);
    CredentialManager.setExtensionMode(true);

    console.log('Logged in via extension with pubkey:', pubkey);
    return pubkey;
  }

  /**
   * Sign event using extension. Same rationale as getPublicKey(): a
   * hidden/unfocused approval popup would otherwise hang this call forever
   * with no feedback, which from the compose form just looks like the
   * extension "isn't activating" — a timeout turns that into a clear error.
   */
  static async signEvent(event: any, timeoutMs: number = 20000): Promise<any> {
    const nostr = (window as NostrWindow).nostr;
    if (!nostr) {
      throw new Error('NOSTR extension not found');
    }
    try {
      return await Promise.race([
        nostr.signEvent(event),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(
              'Extension did not respond in time — its approval prompt may have opened ' +
              'in a window that lost focus or opened behind the browser. Check for another ' +
              'window/taskbar entry, or if you have multiple NOSTR extensions installed ' +
              '(e.g. Alby + nos2x), disable all but one and try again.'
            )),
            timeoutMs
          )
        )
      ]);
    } catch (error) {
      console.error('Failed to sign event with extension:', error);
      throw error;
    }
  }

  /**
   * Encrypt message using extension
   */
  static async encrypt(pubkey: string, plaintext: string): Promise<string | null> {
    try {
      const nostr = (window as NostrWindow).nostr;
      if (!nostr) {
        throw new Error('NOSTR extension not found');
      }
      return await nostr.encrypt(pubkey, plaintext);
    } catch (error) {
      console.error('Failed to encrypt with extension:', error);
      return null;
    }
  }

  /**
   * Decrypt message using extension
   */
  static async decrypt(pubkey: string, ciphertext: string): Promise<string | null> {
    try {
      const nostr = (window as NostrWindow).nostr;
      if (!nostr) {
        throw new Error('NOSTR extension not found');
      }
      return await nostr.decrypt(pubkey, ciphertext);
    } catch (error) {
      console.error('Failed to decrypt with extension:', error);
      return null;
    }
  }

  /**
   * Whether the extension exposes the NIP-44 methods required for
   * NIP-17 private messages — older extensions only support NIP-04
   */
  static hasNip44(): boolean {
    const nostr = (window as NostrWindow).nostr;
    return !!nostr?.nip44?.encrypt && !!nostr?.nip44?.decrypt;
  }

  /**
   * Encrypt using extension (NIP-44)
   */
  static async encryptNip44(pubkey: string, plaintext: string): Promise<string> {
    const nostr = (window as NostrWindow).nostr;
    if (!nostr?.nip44?.encrypt) {
      throw new Error(
        'Your NOSTR extension does not support NIP-44 encryption, required for private ' +
        'messages. Update the extension or switch to one that supports it (e.g. Alby).'
      );
    }
    return await nostr.nip44.encrypt(pubkey, plaintext);
  }

  /**
   * Decrypt using extension (NIP-44)
   */
  static async decryptNip44(pubkey: string, ciphertext: string): Promise<string> {
    const nostr = (window as NostrWindow).nostr;
    if (!nostr?.nip44?.decrypt) {
      throw new Error('Your NOSTR extension does not support NIP-44 decryption, required for private messages.');
    }
    return await nostr.nip44.decrypt(pubkey, ciphertext);
  }

  /**
   * The older scheme, for reading messages sent before NIP-17 existed.
   * Nothing here writes one — this is only so an old conversation is not
   * simply invisible.
   */
  static async decryptNip04(pubkey: string, ciphertext: string): Promise<string> {
    const nostr = (window as NostrWindow).nostr;
    if (!nostr?.nip04?.decrypt) {
      throw new Error('Your NOSTR extension cannot read NIP-04 messages');
    }
    return await nostr.nip04.decrypt(pubkey, ciphertext);
  }
}
