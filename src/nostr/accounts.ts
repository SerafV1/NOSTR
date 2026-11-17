import { CredentialManager, ExtensionManager } from './crypto';

/**
 * The accounts this browser has been used with, so you can move between them
 * without logging out and in again.
 *
 * An extension hands over only the key it is set to at that moment, so a
 * second account read from it is one you first switch to in the extension.
 * A key typed in is remembered the way the one in use already is, in this
 * browser's storage. A signer app's pairing is a single session and is not
 * kept here.
 */
export interface SavedAccount {
  pubkey: string;
  mode: 'extension' | 'key';
  /** Only for a key typed in */
  privkey?: string;
}

const ACCOUNTS_KEY = 'nostr_accounts';

export function listAccounts(): SavedAccount[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(a => a && /^[0-9a-f]{64}$/.test(a.pubkey)) : [];
  } catch {
    return [];
  }
}

function saveAccounts(accounts: SavedAccount[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    // Not remembered; the account in use still works
  }
}

/** The account in use right now, as it would be saved */
function currentAccount(): SavedAccount | null {
  const pubkey = CredentialManager.getPublicKey();
  if (!pubkey) return null;
  if (CredentialManager.isExtensionMode()) return { pubkey, mode: 'extension' };
  const privkey = CredentialManager.getPrivateKey();
  if (privkey && !CredentialManager.isBunkerMode()) return { pubkey, mode: 'key', privkey };
  return null;
}

/** Puts the account in use on the list, if it is not there already */
export function rememberCurrentAccount(): void {
  const current = currentAccount();
  if (!current) return;
  const accounts = listAccounts().filter(a => a.pubkey !== current.pubkey);
  saveAccounts([...accounts, current]);
}

/**
 * An extension account chosen here that the extension itself has not been
 * switched to yet. A page cannot switch an extension (NIP-07 gives it the
 * key in use and nothing else), so until the two agree the page asks for it
 * rather than following the extension straight back to where it was.
 */
const AWAITING_KEY = 'nostr_awaiting_extension';

export const awaitedExtensionAccount = (): string | null => {
  try {
    return localStorage.getItem(AWAITING_KEY);
  } catch {
    return null;
  }
};

export const stopAwaitingExtension = (): void => {
  try {
    localStorage.removeItem(AWAITING_KEY);
  } catch {
    // Nothing stored to begin with
  }
};

/** Makes this account the one in use. The page reloads around it. */
export function switchToAccount(account: SavedAccount, fromExtension = false): void {
  rememberCurrentAccount();
  try {
    if (account.mode === 'extension' && !fromExtension) localStorage.setItem(AWAITING_KEY, account.pubkey);
    else localStorage.removeItem(AWAITING_KEY);
  } catch {
    // Without it the page simply follows the extension
  }
  CredentialManager.clear();
  if (account.mode === 'key' && account.privkey) {
    CredentialManager.storePrivateKey(account.privkey);
  } else {
    CredentialManager.setExtensionMode(true);
  }
  CredentialManager.storePublicKey(account.pubkey);
}

/**
 * Reads whichever key the extension is set to now and adds it. Says so
 * when that key is one already here — the usual sign that the extension
 * has not been switched yet.
 */
export async function addAccountFromExtension(): Promise<
  { added: SavedAccount } | { already: string }
> {
  const pubkey = await ExtensionManager.getPublicKey();
  if (!pubkey) throw new Error('The extension did not give a key');
  rememberCurrentAccount();
  if (pubkey === CredentialManager.getPublicKey() || listAccounts().some(a => a.pubkey === pubkey)) {
    return { already: pubkey };
  }
  const added: SavedAccount = { pubkey, mode: 'extension' };
  saveAccounts([...listAccounts(), added]);
  return { added };
}

/** Takes an account off the list, as logging out of it does */
export function forgetAccount(pubkey: string): void {
  saveAccounts(listAccounts().filter(a => a.pubkey !== pubkey));
}

/**
 * The extension was switched to another account: follow it, adding the
 * account to the list if it is new.
 */
export function followExtensionTo(pubkey: string): void {
  rememberCurrentAccount();
  if (!listAccounts().some(a => a.pubkey === pubkey)) {
    saveAccounts([...listAccounts(), { pubkey, mode: 'extension' }]);
  }
  switchToAccount({ pubkey, mode: 'extension' }, true);
}
