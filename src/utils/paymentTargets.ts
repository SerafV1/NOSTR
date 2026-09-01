import { UserProfile } from '../types';

/**
 * The ways to pay somebody that are not lightning.
 *
 * Lightning has a field everyone agrees on (`lud16`, and `lud06` before it).
 * Nothing else does: of 1,386 profiles sampled from five relays, 106 carried
 * a lightning address and two carried anything else at all — one writing both
 * `xmr` and `monero_address`, one a `cryptocurrency_addresses` object. So
 * this reads generously and writes plainly: every spelling seen in the wild
 * is understood, and what this client writes is the short one.
 *
 * Nothing is shown that does not look like an address. A profile is a string
 * anybody can put anything in, and "here is where to send money" is exactly
 * the place where a plausible-looking mistake costs the reader.
 */

export type PaymentKind = 'bitcoin' | 'monero';

export interface PaymentTarget {
  kind: PaymentKind;
  /** What to call it on screen */
  label: string;
  address: string;
  /** What a wallet on the same device can be handed */
  uri: string;
}

/** Base58 as bitcoin uses it: no 0, O, I or l */
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

const LOOKS_LIKE = {
  // P2PKH and P2SH, then bech32/bech32m (segwit and taproot), then a BIP-352
  // silent payment address
  bitcoin: new RegExp(
    `^(?:[13]${BASE58}{25,34}|bc1[02-9ac-hj-np-z]{6,87}|sp1[02-9ac-hj-np-z]{50,}|tb1[02-9ac-hj-np-z]{6,87})$`
  ),
  // Standard (4…) and integrated (4…, longer) and subaddresses (8…)
  monero: new RegExp(`^[48]${BASE58}{94,105}$`)
};

/** The field names this client understands, most-specific first */
const FIELDS: { kind: PaymentKind; names: string[] }[] = [
  { kind: 'bitcoin', names: ['btc', 'bitcoin', 'bitcoin_address', 'btc_address', 'onchain', 'on_chain', 'onchain_address'] },
  { kind: 'monero', names: ['xmr', 'monero', 'monero_address', 'xmr_address'] }
];

const SCHEME = /^(?:bitcoin|monero):/i;

/**
 * Strip what a pasted address usually comes wrapped in: a wallet's URI
 * scheme, its query parameters, and stray whitespace.
 */
export function cleanAddress(value: unknown): string {
  if (typeof value !== 'string') return '';
  const bare = value.trim().replace(SCHEME, '');
  return bare.split(/[?#\s]/)[0] || '';
}

export function isPayable(kind: PaymentKind, value: string): boolean {
  const address = cleanAddress(value);
  if (!address) return false;
  // A bech32 address may be written in upper case; every other form is
  // case-sensitive and is checked as written
  const candidate = /^(?:BC1|TB1|SP1)/.test(address) ? address.toLowerCase() : address;
  return LOOKS_LIKE[kind].test(candidate);
}

const LABEL: Record<PaymentKind, string> = {
  bitcoin: 'Bitcoin',
  monero: 'Monero'
};

/**
 * What this profile says about being paid, beyond lightning. An address that
 * does not parse is left out rather than shown as something to send to.
 */
export function paymentTargets(profile: UserProfile | null | undefined): PaymentTarget[] {
  if (!profile) return [];
  const held = profile as unknown as Record<string, unknown>;
  const found: PaymentTarget[] = [];

  for (const { kind, names } of FIELDS) {
    // Some profiles keep them in an object of their own rather than at the
    // top level
    const nested = held.cryptocurrency_addresses;
    const sources = [
      ...names.map(name => held[name]),
      ...(nested && typeof nested === 'object'
        ? names.map(name => (nested as Record<string, unknown>)[name])
        : [])
    ];

    for (const source of sources) {
      const address = cleanAddress(source);
      if (!address || !isPayable(kind, address)) continue;
      if (found.some(target => target.address === address)) continue;
      found.push({
        kind,
        label: LABEL[kind],
        address,
        uri: `${kind}:${address}`
      });
      break; // one address per currency, whichever spelling carried it
    }
  }

  return found;
}

/** Enough of an address to recognise, without a line of noise */
export function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}
