import { NostrEventSigned, UserProfile } from '../types';

/**
 * The ways to pay somebody that are not a zap.
 *
 * There is a spec for this after all — NIP-A3, which Amethyst implements as
 * `PaymentTargetsEvent`: a replaceable **kind 10133** whose tags are
 * `["payto", <type>, <address>]`, one per way of being paid. That is what
 * this reads and what it writes, so an address set here shows up there and
 * theirs shows up here.
 *
 * Two older places are still read, because people used them before the kind
 * existed and nothing republishes on their behalf: the kind-0 fields (`btc`,
 * `xmr` and the handful of spellings around them) and, for the forms that
 * cannot be mistaken for anything else, the bio.
 *
 * Nothing is shown that does not look like an address of its kind. A profile
 * is a string anybody can put anything in, and "here is where to send money"
 * is exactly the place where a plausible-looking mistake costs the reader.
 */

/** The tag NIP-A3 puts them in */
export const PAYTO_TAG = 'payto';
/** Replaceable, one per account (NIP-A3) */
export const PAYMENT_TARGETS_KIND = 10133;

export interface PaymentTarget {
  /** The type as written in the event: `bitcoin`, `xmr`, `paypal`, … */
  type: string;
  /** What to call it on screen */
  label: string;
  address: string;
  /** What a wallet on the same device can be handed */
  uri: string;
  /** Where it was found, which decides how much it can be trusted */
  source: 'payto' | 'field' | 'bio';
}

/** Base58 as bitcoin uses it: no 0, O, I or l */
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

const LOOKS_LIKE: Record<string, RegExp> = {
  // P2PKH and P2SH, then bech32/bech32m (segwit and taproot), then a BIP-352
  // silent payment address
  bitcoin: new RegExp(
    `^(?:[13]${BASE58}{25,34}|bc1[02-9ac-hj-np-z]{6,87}|sp1[02-9ac-hj-np-z]{50,}|tb1[02-9ac-hj-np-z]{6,87})$`
  ),
  // Standard and integrated (4…) and subaddresses (8…)
  monero: new RegExp(`^[48]${BASE58}{94,105}$`)
};

/**
 * The same names Amethyst styles, so a chip here says what a chip there
 * says. An unknown type is not dropped — it is shown as itself and handed to
 * a `payto://` URI, which is what RFC 8905 is for.
 */
const KNOWN: Record<string, { label: string; scheme: string; checks?: keyof typeof LOOKS_LIKE }> = {
  bitcoin: { label: 'Bitcoin', scheme: 'bitcoin:', checks: 'bitcoin' },
  btc: { label: 'Bitcoin', scheme: 'bitcoin:', checks: 'bitcoin' },
  onchain: { label: 'Bitcoin', scheme: 'bitcoin:', checks: 'bitcoin' },
  monero: { label: 'Monero', scheme: 'monero:', checks: 'monero' },
  xmr: { label: 'Monero', scheme: 'monero:', checks: 'monero' },
  lightning: { label: 'Lightning', scheme: 'lightning:' },
  ln: { label: 'Lightning', scheme: 'lightning:' },
  lnurl: { label: 'LNURL', scheme: 'lightning:' },
  liquid: { label: 'Liquid', scheme: 'liquidnetwork:' },
  ethereum: { label: 'Ethereum', scheme: 'ethereum:' },
  eth: { label: 'Ethereum', scheme: 'ethereum:' },
  dash: { label: 'Dash', scheme: 'dash:' },
  zcash: { label: 'Zcash', scheme: 'zcash:' },
  zec: { label: 'Zcash', scheme: 'zcash:' },
  bitcoincash: { label: 'Bitcoin Cash', scheme: 'bitcoincash:' },
  bch: { label: 'Bitcoin Cash', scheme: 'bitcoincash:' },
  litecoin: { label: 'Litecoin', scheme: 'litecoin:' },
  ltc: { label: 'Litecoin', scheme: 'litecoin:' },
  dogecoin: { label: 'Dogecoin', scheme: 'dogecoin:' },
  doge: { label: 'Dogecoin', scheme: 'dogecoin:' },
  solana: { label: 'Solana', scheme: 'solana:' },
  sol: { label: 'Solana', scheme: 'solana:' },
  tron: { label: 'Tron', scheme: 'tron:' },
  trx: { label: 'Tron', scheme: 'tron:' },
  cashapp: { label: 'Cash App', scheme: 'https://cash.app/' },
  venmo: { label: 'Venmo', scheme: 'https://venmo.com/' },
  paypal: { label: 'PayPal', scheme: 'https://paypal.me/' }
};

const SCHEME = /^[a-z][a-z0-9+.-]*:(?:\/\/)?/i;

/**
 * Strip what a pasted address usually comes wrapped in: a wallet's URI
 * scheme, its query parameters, and stray whitespace.
 */
export function cleanAddress(value: unknown): string {
  if (typeof value !== 'string') return '';
  const bare = value.trim().replace(SCHEME, '');
  return bare.split(/[?#\s]/)[0] || '';
}

/** Whether this reads as an address of that kind, where this client knows */
export function isPayable(kind: 'bitcoin' | 'monero', value: string): boolean {
  const address = cleanAddress(value);
  if (!address) return false;
  // A bech32 address may be written in upper case; every other form is
  // case-sensitive and is checked as written
  const candidate = /^(?:BC1|TB1|SP1)/.test(address) ? address.toLowerCase() : address;
  return LOOKS_LIKE[kind].test(candidate);
}

const describe = (type: string, address: string, source: PaymentTarget['source']): PaymentTarget | null => {
  const key = type.trim().toLowerCase();
  const known = KNOWN[key];

  if (known?.checks && !isPayable(known.checks as 'bitcoin' | 'monero', address)) return null;
  // A type this client has never heard of is still somebody's money: shown
  // as itself, with the URI RFC 8905 defines for exactly this case
  if (!address || address.length > 200) return null;

  return {
    type: key,
    label: known?.label || key.toUpperCase(),
    address,
    uri: known ? `${known.scheme}${address}` : `payto://${encodeURIComponent(key)}/${encodeURIComponent(address)}`,
    source
  };
};

/** What a NIP-A3 event says: `["payto", type, address]`, one per way */
export function fromPaytoEvent(event: NostrEventSigned | null | undefined): PaymentTarget[] {
  if (!event || event.kind !== PAYMENT_TARGETS_KIND) return [];
  const found: PaymentTarget[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== PAYTO_TAG || !tag[1] || !tag[2]) continue;
    const target = describe(tag[1], cleanAddress(tag[2]), 'payto');
    if (!target) continue;
    if (found.some(already => already.type === target.type && already.address === target.address)) continue;
    found.push(target);
  }

  return found;
}

/** The kind-0 spellings people used before the kind existed */
const FIELDS: { type: string; names: string[] }[] = [
  { type: 'bitcoin', names: ['btc', 'bitcoin', 'bitcoin_address', 'btc_address', 'onchain', 'on_chain', 'onchain_address'] },
  { type: 'monero', names: ['xmr', 'monero', 'monero_address', 'xmr_address'] }
];

/**
 * Addresses written into a bio instead of anywhere structured. Measured on
 * 1,357 profiles: four carried one in a field, three in their `about` text.
 *
 * Only the forms that cannot be anything else are taken from prose: bech32
 * bitcoin, silent payments, and Monero's 95-character addresses. A legacy
 * `1…` address is 26 to 35 base58 characters, which a word or an id in a
 * sentence can be by accident — and an accident here is money sent to a
 * stranger.
 */
const IN_TEXT: Record<string, RegExp> = {
  bitcoin: /(?:^|[^0-9A-Za-z])((?:bc1|sp1)[02-9ac-hj-np-z]{20,100})(?![0-9A-Za-z])/gi,
  monero: new RegExp(`(?:^|[^0-9A-Za-z])([48]${BASE58}{94,105})(?![0-9A-Za-z])`, 'g')
};

/**
 * Everything this profile says about being paid, in the order it should be
 * believed: the event made for it, then the old fields, then the bio.
 */
export function paymentTargets(
  profile: UserProfile | null | undefined,
  paytoEvent?: NostrEventSigned | null
): PaymentTarget[] {
  const found = fromPaytoEvent(paytoEvent);
  const held = (profile || {}) as unknown as Record<string, unknown>;

  const add = (target: PaymentTarget | null) => {
    if (!target) return;
    // One per currency: a second copy of the same thing from an older place
    // is the same thing
    if (found.some(already => already.label === target.label)) return;
    found.push(target);
  };

  for (const { type, names } of FIELDS) {
    const nested = held.cryptocurrency_addresses;
    const sources = [
      ...names.map(name => held[name]),
      ...(nested && typeof nested === 'object'
        ? names.map(name => (nested as Record<string, unknown>)[name])
        : [])
    ];
    for (const source of sources) {
      const address = cleanAddress(source);
      if (!address) continue;
      const target = describe(type, address, 'field');
      if (target) { add(target); break; }
    }
  }

  const about = String(held.about || '');
  for (const [type, pattern] of Object.entries(IN_TEXT)) {
    const scan = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = scan.exec(about)) !== null) {
      const target = describe(type, match[1], 'bio');
      if (target) { add(target); break; }
    }
  }

  return found;
}

/** Enough of an address to recognise, without a line of noise */
export function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}

/** The tags a NIP-A3 event carries for these targets */
export function paytoTags(targets: { type: string; address: string }[]): string[][] {
  return targets
    .filter(target => target.type && target.address)
    .map(target => [PAYTO_TAG, target.type, target.address]);
}
