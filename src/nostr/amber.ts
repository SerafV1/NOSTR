import { getEventHash, nip19 } from 'nostr-tools';
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

// A cold signer app can take a couple of seconds to come up, and firing a
// second navigation while it does would yank the page out from under it —
// so wait generously and then stop, rather than trying again behind the
// user's back.
const GIVE_UP_MS = 4000;

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
 * Android switching to the signer app does NOT unload this page — it goes to
 * the background and comes back later. So a successful hand-off is signalled
 * by the document being hidden or the window losing focus, never by unload:
 * watching for pagehide reported "Amber did not open" every single time,
 * while Amber was in fact open in front of the user.
 */
const handOff = (uri: string, request: PendingRequest): Promise<never> => {
  storePending(request);
  return new Promise<never>((_, reject) => {
    let settled = false;

    const cleanup = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', succeeded);
      window.removeEventListener('pagehide', succeeded);
    };

    const succeeded = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      // The pending request stays: the signer has it, and the answer arrives
      // on the callback URL once the user approves
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') succeeded();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', succeeded);
    window.addEventListener('pagehide', succeeded);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      // Deliberately keeps the pending request. Whether the signer opened
      // can't be known for certain from in here — a phone that switched apps
      // without firing blur or visibilitychange looks identical to one with
      // nothing installed. Throwing away the request would turn that
      // uncertainty into a broken round trip; leaving it means that if the
      // signer did open, coming back still completes the job, and the worst
      // case is a message the user can ignore.
      reject(new Error(
        'No signer app answered yet. If Amber opened, approve there and this page will pick it up. ' +
        'Otherwise install Amber (or another NIP-55 signer) and try again.'
      ));
    }, GIVE_UP_MS);

    window.location.href = uri;
  });
};

/**
 * The same request written as an Android intent: URL. Some browsers drop a
 * bare custom-scheme navigation but resolve this one, so it's offered as a
 * deliberate retry — never fired automatically, since a second navigation
 * while the signer is still opening would interrupt it.
 */
export const intentUri = (params: Record<string, string>, payload?: string): string => {
  const extras = Object.entries(params)
    .map(([key, value]) => `S.${key}=${encodeURIComponent(value)}`)
    .join(';');
  const data = payload ? encodeURIComponent(payload) : '';
  return `intent://${data}#Intent;scheme=nostrsigner;${extras};end`;
};

/** The login request as an intent: URL, for the explicit retry */
export const publicKeyIntentUri = (): string =>
  intentUri({
    compressionType: 'none',
    returnType: 'signature',
    type: 'get_public_key',
    callbackUrl: callbackUrl('amberPubkey')
  });

/** Ask the signer who the user is. Navigates away. */
export const requestPublicKey = (): Promise<never> => {
  const params = {
    compressionType: 'none',
    returnType: 'signature',
    type: 'get_public_key',
    appName: 'NOSTR Web App',
    // Asked for at connection time so posting doesn't prompt separately
    permissions: JSON.stringify([{ type: 'sign_event' }]),
    callbackUrl: callbackUrl('amberPubkey')
  };
  return handOff(
    `nostrsigner:?${new URLSearchParams(params).toString()}`,
    { type: 'get_public_key', startedAt: Date.now() }
  );
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
  const params = {
    compressionType: 'none',
    returnType: 'event',
    type: 'sign_event',
    callbackUrl: callbackUrl('amberEvent')
  };
  const payload = JSON.stringify(template);
  const uri = `nostrsigner:${encodeURIComponent(payload)}?${new URLSearchParams(params).toString()}`;
  return handOff(uri, { type: 'sign_event', event: template, startedAt: Date.now() });
};

/**
 * Read whatever the signer appended to the URL on its way back, and clean
 * the address bar so a reload doesn't replay it.
 */
/**
 * Read whatever the signer appended on its way back.
 *
 * Deliberately not looking for one parameter name: the spec says only that
 * the result is "appended to the callbackUrl", and signers differ on what
 * they call it — so match on the shape of the value instead, across every
 * parameter present. A returned bare signature is enough too: the pending
 * request still holds the event it belongs to.
 */
export const consumeCallback = (): AmberResult | null => {
  const url = new URL(window.location.href);
  const allParams = Array.from(url.searchParams.entries());
  if (allParams.length === 0) return null;

  const pending = readPending();
  // Nothing was asked for, so nothing here is an answer — leave the URL be
  if (!pending) return null;

  // Keep the empty ones in view: a reply of "?amberPubkey=" with nothing
  // after it is a failure worth saying out loud, not silence to return to
  // the login screen with
  const params = allParams.filter(([, value]) => value.trim() !== '');
  const values = params.map(([, value]) => value.trim());
  const explicitError = url.searchParams.get('amberError') || url.searchParams.get('error');

  const cleanUrl = () => {
    for (const [key] of allParams) url.searchParams.delete(key);
    window.history.replaceState({}, '', url.toString());
  };

  const asPubkey = (value: string): string | null => {
    if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
    if (/^npub1[a-z0-9]+$/i.test(value)) {
      try {
        const decoded = nip19.decode(value);
        if (decoded.type === 'npub' && typeof decoded.data === 'string') return decoded.data;
      } catch {
        // not a usable npub after all
      }
    }
    return null;
  };

  const asSignedEvent = (value: string): NostrEventSigned | null => {
    try {
      const parsed = JSON.parse(value);
      if (parsed && parsed.sig && parsed.id && parsed.pubkey) return parsed as NostrEventSigned;
    } catch {
      // not JSON — may still be a bare signature, handled below
    }
    return null;
  };

  clearPending();
  cleanUrl();

  if (explicitError) return { type: 'error', message: explicitError };

  if (values.length === 0) {
    return {
      type: 'error',
      message: `The signer came back empty (${allParams.map(([key]) => key).join(', ')}). ` +
        'It may have refused the request, or it may need to be approved in the app first.'
    };
  }

  if (pending.type === 'get_public_key') {
    for (const value of values) {
      const pubkey = asPubkey(value);
      if (pubkey) return { type: 'get_public_key', pubkey };
    }
    return {
      type: 'error',
      message: `Signer replied without a usable public key: ${values.join(' | ').slice(0, 160)}`
    };
  }

  // sign_event
  for (const value of values) {
    const event = asSignedEvent(value);
    if (event) return { type: 'sign_event', event };
  }
  // returnType=signature gives back only the signature; the template we kept
  // supplies everything else the event needs
  const signature = values.find(value => /^[0-9a-f]{128}$/i.test(value));
  if (signature && pending.event) {
    const template = pending.event as NostrEvent & { pubkey: string; created_at: number };
    return {
      type: 'sign_event',
      event: { ...template, id: getEventHash(template as any), sig: signature } as NostrEventSigned
    };
  }

  return {
    type: 'error',
    message: `Signer replied with something unrecognised: ${values.join(' | ').slice(0, 160)}`
  };
};
