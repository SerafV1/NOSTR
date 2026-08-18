import React, { useState } from 'react';
import { resolveLnurlInvoice } from '../utils/zap';
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
      window.open(`lightning:${invoice}`, '_blank');
      setShowMenu(false);
      setCustomAmount('');
      setComment('');
    } catch (error) {
      console.error('Zap failed:', error);
      alert(error instanceof Error ? error.message : 'Failed to create zap invoice');
    } finally {
      setLoading(false);
    }
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
          {!lud16 ? (
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
