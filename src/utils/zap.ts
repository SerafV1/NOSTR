// LUD-16 (Lightning Address) → LNURL-pay → BOLT11 invoice resolution.
//
// A `lightning:` URI only understands a BOLT11 invoice or an LNURL — not a
// bare Lightning Address (user@domain). To actually zap someone we have to
// resolve their address into an invoice first, per LUD-16/LUD-06.

interface LnurlPayResponse {
  tag?: string;
  callback?: string;
  minSendable?: number;
  maxSendable?: number;
  /** NIP-57: set when the provider will publish a zap receipt */
  allowsNostr?: boolean;
  nostrPubkey?: string;
}

/**
 * Builds the signed kind 9734 to attach to the payment. Given by the
 * caller because signing lives in the nostr layer, not here. Returning
 * null falls back to a plain, private LNURL payment.
 */
export type ZapRequestBuilder = (amountMsats: number) => Promise<string | null>;

interface LnurlInvoiceResponse {
  pr?: string;
  reason?: string;
}

/**
 * Resolve a Lightning Address + amount into a payable BOLT11 invoice.
 * Throws with a user-facing message on any failure.
 */
export async function resolveLnurlInvoice(
  lud16: string,
  amountSats: number,
  buildZapRequest?: ZapRequestBuilder
): Promise<string> {
  const [name, domain] = lud16.split('@');
  if (!name || !domain) {
    throw new Error('Invalid lightning address');
  }
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error('Enter a valid amount in sats');
  }

  const payInfo = await fetchJson<LnurlPayResponse>(
    `https://${domain}/.well-known/lnurlp/${name}`,
    'Could not reach the lightning address provider'
  );

  if (payInfo.tag !== 'payRequest' || !payInfo.callback) {
    throw new Error('This lightning address does not support LNURL-pay');
  }

  const amountMsats = Math.round(amountSats * 1000);
  if (payInfo.minSendable && amountMsats < payInfo.minSendable) {
    throw new Error(`Minimum amount is ${Math.ceil(payInfo.minSendable / 1000)} sats`);
  }
  if (payInfo.maxSendable && amountMsats > payInfo.maxSendable) {
    throw new Error(`Maximum amount is ${Math.floor(payInfo.maxSendable / 1000)} sats`);
  }

  // Without the `nostr` parameter the payment is just a payment: the
  // provider publishes no zap receipt, so nobody — not the recipient, not
  // the stream — ever learns it happened. Only providers that advertise
  // allowsNostr accept it.
  let zapRequestParam = '';
  if (payInfo.allowsNostr && payInfo.nostrPubkey && buildZapRequest) {
    const zapRequest = await buildZapRequest(amountMsats);
    if (zapRequest) {
      zapRequestParam = `&nostr=${encodeURIComponent(zapRequest)}`;
    }
  }

  const separator = payInfo.callback.includes('?') ? '&' : '?';
  const invoiceInfo = await fetchJson<LnurlInvoiceResponse>(
    `${payInfo.callback}${separator}amount=${amountMsats}${zapRequestParam}`,
    'Failed to request an invoice'
  );

  if (!invoiceInfo.pr) {
    throw new Error(invoiceInfo.reason || 'No invoice returned');
  }
  return invoiceInfo.pr;
}

async function fetchJson<T>(url: string, errorContext: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(errorContext);
  }
  if (!response.ok) {
    throw new Error(errorContext);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error(errorContext);
  }
}
