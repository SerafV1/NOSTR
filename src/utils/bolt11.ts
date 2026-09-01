/**
 * Reading the amount out of a BOLT11 invoice.
 *
 * This is the check that stands between "the user chose 21 sats" and what a
 * stranger's server actually sent back: an LNURL callback returns an invoice,
 * and nothing about that invoice is verified by anything else in the flow.
 * The amount is written into the human-readable part, before the bech32
 * separator, so it can be read without decoding the rest.
 *
 *   lnbc  210n  1  pvjluezpu…
 *   ───┬  ──┬─  ┬
 *   prefix │  └ bech32 separator (the LAST '1' in the string)
 *          └ amount and its multiplier
 *
 * The multipliers are fractions of a bitcoin: m = 10⁻³, u = 10⁻⁶, n = 10⁻⁹,
 * p = 10⁻¹². One bitcoin is 10¹¹ millisats, and a `p` amount must be a
 * multiple of 10 because a tenth of a millisat cannot be paid.
 */

const MULTIPLIER: Record<string, number> = {
  m: 100_000_000,
  u: 100_000,
  n: 100,
  p: 0.1
};

/** One bitcoin, in millisats — the value of an amount with no multiplier */
const BTC_IN_MSATS = 100_000_000_000;

/**
 * What this invoice asks for, in millisats — or null if it asks for nothing
 * in particular (an open invoice, payable for any amount) or is not an
 * invoice at all. Null is a refusal, not a zero: an amount that cannot be
 * read is an amount that cannot be checked.
 */
export function invoiceAmountMsats(invoice: string): number | null {
  const trimmed = invoice.trim().toLowerCase();
  if (!trimmed.startsWith('ln')) return null;

  // bech32 separates the human-readable part at the last '1', because the
  // part after it cannot contain one
  const separator = trimmed.lastIndexOf('1');
  if (separator <= 0) return null;
  const human = trimmed.slice(0, separator);

  // lnbc (mainnet), lntb (testnet), lnbcrt (regtest), lnsb (signet)
  const parsed = /^ln(bcrt|bc|tb|sb)(\d+)?([munp])?$/.exec(human);
  if (!parsed) return null;

  const [, , digits, multiplier] = parsed;
  if (!digits) return null; // no amount: the payer decides, so nothing to check

  const amount = Number(digits);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const msats = multiplier ? amount * MULTIPLIER[multiplier] : amount * BTC_IN_MSATS;
  // A pico amount that is not a multiple of ten would be a fraction of a
  // millisat, which no invoice may ask for
  if (!Number.isInteger(msats)) return null;

  return msats;
}
