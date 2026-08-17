import { NostrEvent, NostrEventSigned } from '../types';

/**
 * NIP-55: signing through an Android signer app (Amber).
 *
 * There is no in-page API here the way NIP-07 gives one. A request is a
 * navigation to a `nostrsigner:` URI; the signer opens, the user approves,
 * and it navigates back to a callback URL with the result appended. So every
 * signature costs a round trip out of the browser and back, and anything the
 * app was in the middle of has to survive that trip in storage.
 */

const PENDING_KEY = 'nostr_amber_pending';

/** What the app was doing when it handed off to the signer */
interface PendingRequest {
  type: 'get_public_key' | 'sign_event';
  /** Set for sign_event: published as-is once the signature comes back */
  event?: NostrEvent;
  startedAt: number;
}

export type AmberResult =
  | { type: 'get_public_key'; pubkey: string }
  | { type: 'sign_event'; event: NostrEventSigned }
  | { type: 'error'; message: string };

// Android only: the scheme is handled by an installed app, and nothing else
// answers it. Tablets report the same, which is what we want.
export const isAndroid = (): boolean =>
  typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);

/**
 * Amber never opening is indistinguishable from a slow app, so give up after
 * a moment rather than leaving the caller waiting on a promise forever.
 */
const OPEN_TIMEOUT_MS = 2500;

const callbackUrl = (param: string): string => {
  const url = new URL(window.location.href);
  // Don't carry an older result forward into the next request
  url.searchParams.delete('amberPubkey');
  url.searchParams.delete('amberEvent');
  url.searchParams.delete('amberError');
  const base = url.toString();
  return `${base}${base.includes('?') ? '&' : '?'}${param}=`;
};

const storePending = (request: PendingRequest): void => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(request));
  } catch {
    // If this fails the round trip can't be resumed, but the request itself
    // may still succeed — the signer just has nowhere to come back to
  }
};

const readPending = (): PendingRequest | null => {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingRequest) : null;
  } catch {
    return null;
  }
};

export const clearPending = (): void => localStorage.removeItem(PENDING_KEY);

/**
 * Hand off to the signer. Resolves only if the navigation didn't happen —
 * on success the page is gone and the answer arrives in the callback URL.
 */
const handOff = (uri: string, request: PendingRequest): Promise<never> => {
  storePending(request);
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      clearPending();
      reject(new Error(
        'Amber did not open. Install Amber (or another NIP-55 signer) and try again.'
      ));
    }, OPEN_TIMEOUT_MS);

    // A completed hand-off unloads the page, so this listener firing is the
    // signal that it worked and the timeout should not
    window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
    window.location.href = uri;
  });
};

/** Ask the signer who the user is. Navigates away. */
export const requestPublicKey = (): Promise<never> => {
  const params = new URLSearchParams({
    compressionType: 'none',
    returnType: 'signature',
    type: 'get_public_key',
    callbackUrl: callbackUrl('amberPubkey')
  });
  return handOff(`nostrsigner:?${params.toString()}`, {
    type: 'get_public_key',
    startedAt: Date.now()
  });
};

/**
 * Ask the signer to sign an event. Navigates away; the signed event comes
 * back through the callback URL and is published on return.
 */
export const requestSignature = (event: NostrEvent, pubkey: string): Promise<never> => {
  // NIP-55 takes the event as JSON in the URI, so it needs everything a
  // signer would otherwise have to guess
  const template = {
    kind: event.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: event.tags || [],
    content: event.content,
    pubkey
  };
  const params = new URLSearchParams({
    compressionType: 'none',
    returnType: 'event',
    type: 'sign_event',
    callbackUrl: callbackUrl('amberEvent')
  });
  const uri = `nostrsigner:${encodeURIComponent(JSON.stringify(template))}?${params.toString()}`;
  return handOff(uri, { type: 'sign_event', event: template, startedAt: Date.now() });
};

/**
 * Read whatever the signer appended to the URL on its way back, and clean
 * the address bar so a reload doesn't replay it.
 */
export const consumeCallback = (): AmberResult | null => {
  const url = new URL(window.location.href);
  const pubkey = url.searchParams.get('amberPubkey');
  const eventParam = url.searchParams.get('amberEvent');
  const error = url.searchParams.get('amberError');
  if (!pubkey && !eventParam && !error) return null;

  const pending = readPending();
  clearPending();

  url.searchParams.delete('amberPubkey');
  url.searchParams.delete('amberEvent');
  url.searchParams.delete('amberError');
  window.history.replaceState({}, '', url.toString());

  if (error) return { type: 'error', message: error };

  if (pubkey) return { type: 'get_public_key', pubkey };

  if (eventParam) {
    try {
      const parsed = JSON.parse(eventParam);
      // Some signers return only the signature; the template we kept has
      // everything else needed to make a complete event out of it
      if (typeof parsed === 'object' && parsed.sig && parsed.id) {
        return { type: 'sign_event', event: parsed as NostrEventSigned };
      }
      return { type: 'error', message: 'Signer returned an incomplete event' };
    } catch {
      if (pending?.event) {
        return { type: 'error', message: 'Could not read the signed event from Amber' };
      }
      return { type: 'error', message: 'Unexpected reply from Amber' };
    }
  }

  return null;
};
