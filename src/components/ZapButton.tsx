import React, { useState } from 'react';
import { resolveLnurlInvoice, payWithWebln } from '../utils/zap';
import { NostrCore } from '../nostr/core';
import { useAnchoredPopup } from '../hooks/useAnchoredPopup';
import EmojiText from './EmojiText';

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
  /** Shown in the menu, so it is clear who the sats are going to */
  recipientName?: string;
  recipientPicture?: string;
  /** Their name may be written with NIP-30 emoji */
  recipientEmojis?: Record<string, string>;
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
  eventAddress,
  recipientName,
  recipientPicture,
  recipientEmojis
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  // Picking an amount marks it; nothing is paid until Zap is pressed. Money
  // leaving on a single click, before a message could even be typed, is not
  // a thing to do by accident.
  const [chosen, setChosen] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { containerRef, triggerRef, popupRef, style, openPopup, render } =
    useAnchoredPopup(showMenu, () => setShowMenu(false), [invoice, loading]);

  /** What pressing Zap would pay: what was typed, else what was picked */
  const amountToSend = Number(customAmount) > 0 ? Number(customAmount) : (chosen || 0);

  const sendZap = async (amountSats: number) => {
    if (!lud16 || loading) return;

    setLoading(true);
    try {
      // Told who the recipient is, the payment becomes a real NIP-57 zap:
      // the wallet publishes a receipt, so it shows up on the note, the
      // profile and — for a stream — in its chat. Without a recipient it
      // is an ordinary private lightning payment, as before.
      const invoice = await resolveLnurlInvoice(
        lud16,
        amountSats,
        recipientPubkey
          ? (amountMsats) => NostrCore.createZapRequest({
              recipientPubkey,
              amountMsats,
              eventId,
              eventAddress,
              comment: comment.trim()
            })
          : undefined,
        // Carried by the payment itself where the zap request cannot take it:
        // a tip to a plain lightning address still arrives with a word on it
        comment.trim()
      );

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
    <div className="zap-container" ref={containerRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        onClick={() => {
          if (showMenu) {
            setShowMenu(false);
            return;
          }
          openPopup();
          setShowMenu(true);
        }}
        title={triggerTitle || 'Zap with lightning'}
      >
        {children}
      </button>

      {showMenu && render(
        <div className="zap-menu" ref={popupRef} style={style}>
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
              {/* Several of these can be on screen at once — in a chat, one per
                  message — so the menu says whose it is */}
              {(recipientName || recipientPicture) && (
                <div className="zap-menu-recipient">
                  {recipientPicture ? (
                    <img src={recipientPicture} alt="" className="zap-menu-avatar"  loading="lazy" decoding="async" />
                  ) : (
                    <div className="zap-menu-avatar-placeholder">
                      {(recipientName || '?').charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span>
                    Zap{' '}
                    <strong>
                      <EmojiText text={recipientName || 'this user'} emojis={recipientEmojis} />
                    </strong>
                  </span>
                </div>
              )}
              <div className="zap-amounts">
                {PRESET_AMOUNTS.map(amount => (
                  <button
                    key={amount}
                    type="button"
                    className={`zap-amount-btn ${chosen === amount ? 'chosen' : ''}`}
                    disabled={loading}
                    onClick={() => { setChosen(amount); setCustomAmount(''); }}
                  >
                    ⚡{amount >= 1000 ? `${amount / 1000}k` : amount}
                  </button>
                ))}
              </div>
              {/* Offered wherever there is something to pay: as part of the
                  zap where the recipient is known, and as the payment's own
                  note where they are not */}
              <input
                type="text"
                className="zap-comment"
                placeholder="Message (optional)"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                disabled={loading}
                maxLength={200}
              />
              <div className="zap-custom">
                <input
                  type="number"
                  min={1}
                  placeholder="Custom sats"
                  value={customAmount}
                  onChange={(e) => { setCustomAmount(e.target.value); setChosen(null); }}
                  disabled={loading}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={loading || amountToSend <= 0}
                  onClick={() => sendZap(amountToSend)}
                >
                  {loading ? '...' : `Zap${amountToSend > 0 ? ` ${amountToSend.toLocaleString()}` : ''}`}
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
