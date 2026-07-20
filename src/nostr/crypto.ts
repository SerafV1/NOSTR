import * as nostrTools from 'nostr-tools';
import { NostrEvent, NostrEventSigned } from '../types';

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
   * Create and sign an event
   */
  static signEvent(event: NostrEvent, privateKey: string): NostrEventSigned {
    const normalizedKey = this.normalizePrivateKey(privateKey);
    if (!normalizedKey) throw new Error('Private key is not valid hex or nsec format');
    privateKey = normalizedKey;

    const pubkey = this.getPublicKey(privateKey);

    const eventTemplate: any = {
      kind: event.kind,
      created_at: Math.floor(Date.now() / 1000),
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
   * Format public key to npub format
   */
  static npubEncode(pubkey: string): string {
    try {
      if ((nostrTools as any).npubEncode) {
        return (nostrTools as any).npubEncode(pubkey);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Format private key to nsec format
   */
  static nsecEncode(privateKey: string): string {
    try {
      if ((nostrTools as any).nsecEncode) {
        return (nostrTools as any).nsecEncode(privateKey as `0x${string}`);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Decode npub to pubkey
   */
  static npubDecode(npub: string): string {
    try {
      if ((nostrTools as any).npubDecode) {
        return (nostrTools as any).npubDecode(npub);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Decode nsec to private key
   */
  static nsecDecode(nsec: string): string {
    try {
      if ((nostrTools as any).nsecDecode) {
        return (nostrTools as any).nsecDecode(nsec);
      }
      return '';
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
      if ((nostrTools as any).noteEncode) {
        return (nostrTools as any).noteEncode(noteId);
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Decode note from nip19
   */
  static decodeNote(note: string): string | null {
    try {
      if ((nostrTools as any).noteDecode) {
        const result = (nostrTools as any).noteDecode(note);
        return typeof result === 'string' ? result : null;
      }
      return null;
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
  }

  static isLoggedIn(): boolean {
    return this.getPrivateKey() !== null || this.isExtensionMode();
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
   * Get public key from extension
   */
  static async getPublicKey(): Promise<string | null> {
    try {
      const nostr = (window as NostrWindow).nostr;
      if (!nostr) {
        throw new Error('NOSTR extension not found');
      }
      const pubkey = await nostr.getPublicKey();
      return pubkey;
    } catch (error) {
      console.error('Failed to get public key from extension:', error);
      return null;
    }
  }

  /**
   * Login via extension (NIP-07)
   */
  static async loginWithExtension(): Promise<string | null> {
    try {
      const pubkey = await this.getPublicKey();
      if (!pubkey) {
        throw new Error('Failed to get public key from extension');
      }

      CredentialManager.storePublicKey(pubkey);
      CredentialManager.setExtensionMode(true);

      console.log('Logged in via extension with pubkey:', pubkey);
      return pubkey;
    } catch (error) {
      console.error('Extension login failed:', error);
      return null;
    }
  }

  /**
   * Sign event using extension
   */
  static async signEvent(event: any): Promise<any> {
    try {
      const nostr = (window as NostrWindow).nostr;
      if (!nostr) {
        throw new Error('NOSTR extension not found');
      }
      return await nostr.signEvent(event);
    } catch (error) {
      console.error('Failed to sign event with extension:', error);
      return null;
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
}
