import React, { useState } from 'react';
import { resolveLnurlInvoice, payWithWebln } from '../utils/zap';
import { NostrCore } from '../nostr/core';

interface ZapButtonProps {
  lud16?: string;
  triggerClassName: string;
  triggerTitle?: string;
  children: React.ReactNode;
  /** Who is being paid. Without it the zap stays private — see sendZap */
  recipientPubkey?: string;
  /** What the zap is for: a note, or a live stream's address */
  eventId?: string;
  eventAddress?: string;
}

const PRESET_AMOUNTS = [21, 100, 500, 1000, 5000, 21000];

/**
 * Zap trigger + amount-picker popup. Resolves the recipient's Lightning
 * Address to a payable invoice (LUD-16/LNURL-pay) before handing off to
 * the user's wallet — a bare `lightning:user@domain` URI isn't valid and
 * silently fails in most wallets, which is why zapping needs this step.
 */
const ZapButton: React.FC<ZapButtonProps> = ({
  lud16,
  triggerClassName,
  triggerTitle,
  children,
  recipientPubkey,
  eventId,
  eventAddress
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const sendZap = async (amountSats: number) => {
    if (!lud16 || loading) return;

    setLoading(true);
    try {
      // Told who the recipient is, the payment becomes a real NIP-57 zap:
      // the wallet publishes a receipt, so it shows up on the note, the
      // profile and — for a stream — in its chat. Without a recipient it
      // is an ordinary private lightning payment, as before.
      const invoice = await resolveLnurlInvoice(lud16, amountSats, recipientPubkey
        ? (amountMsats) => NostrCore.createZapRequest({
            recipientPubkey,
            amountMsats,
            eventId,
            eventAddress,
            comment: comment.trim()
          })
        : undefined);

      // An extension wallet answers over WebLN, not the `lightning:` scheme
      const paid = await payWithWebln(invoice);
      if (paid) {
        setShowMenu(false);
        setCustomAmount('');
        setComment('');
        return;
      }

      // No WebLN wallet here: show the invoice so it can be paid elsewhere,
      // rather than opening a URI nothing is listening for
      setInvoice(invoice);
    } catch (error) {
      console.error('Zap failed:', error);
      alert(error instanceof Error ? error.message : 'Failed to create zap invoice');
    } finally {
      setLoading(false);
    }
  };

  const closeMenu = () => {
    setShowMenu(false);
    setInvoice(null);
    setCustomAmount('');
    setComment('');
    setCopied(false);
  };

  return (
    <div className="zap-container" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={triggerClassName}
        onClick={() => setShowMenu(show => !show)}
        title={triggerTitle || 'Zap with lightning'}
      >
        {children}
      </button>

      {showMenu && (
        <div className="zap-menu">
          {invoice ? (
            // Nothing here can pay it, so the invoice itself is the answer
            <div className="zap-invoice">
              <div className="zap-invoice-hint">
                No lightning wallet in this browser — pay this invoice from your wallet:
              </div>
              <textarea className="zap-invoice-text" readOnly value={invoice} rows={4} />
              <div className="zap-invoice-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={async () => {
                    await navigator.clipboard.writeText(invoice);
                    setCopied(true);
                  }}
                >
                  {copied ? 'Copied' : 'Copy invoice'}
                </button>
                {/* A real link, so the click reaches any handler that does exist */}
                <a className="btn btn-secondary btn-small" href={`lightning:${invoice}`}>
                  Open wallet
                </a>
                <button type="button" className="btn btn-secondary btn-small" onClick={closeMenu}>
                  Close
                </button>
              </div>
            </div>
          ) : !lud16 ? (
            <div className="zap-menu-empty">No lightning address set for this profile</div>
          ) : (
            <>
              <div className="zap-amounts">
                {PRESET_AMOUNTS.map(amount => (
                  <button
                    key={amount}
                    type="button"
                    className="zap-amount-btn"
                    disabled={loading}
                    onClick={() => sendZap(amount)}
                  >
                    ⚡{amount >= 1000 ? `${amount / 1000}k` : amount}
                  </button>
                ))}
              </div>
              {recipientPubkey && (
                <input
                  type="text"
                  className="zap-comment"
                  placeholder="Comment (optional)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  disabled={loading}
                  maxLength={200}
                />
              )}
              <div className="zap-custom">
                <input
                  type="number"
                  min={1}
                  placeholder="Custom sats"
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  disabled={loading}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={loading || !customAmount || Number(customAmount) <= 0}
                  onClick={() => sendZap(Number(customAmount))}
                >
                  {loading ? '...' : 'Zap'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ZapButton;
