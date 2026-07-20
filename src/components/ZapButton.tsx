import React, { useState } from 'react';
import { resolveLnurlInvoice } from '../utils/zap';

interface ZapButtonProps {
  lud16?: string;
  triggerClassName: string;
  triggerTitle?: string;
  children: React.ReactNode;
}

const PRESET_AMOUNTS = [21, 100, 500, 1000, 5000, 21000];

/**
 * Zap trigger + amount-picker popup. Resolves the recipient's Lightning
 * Address to a payable invoice (LUD-16/LNURL-pay) before handing off to
 * the user's wallet — a bare `lightning:user@domain` URI isn't valid and
 * silently fails in most wallets, which is why zapping needs this step.
 */
const ZapButton: React.FC<ZapButtonProps> = ({ lud16, triggerClassName, triggerTitle, children }) => {
  const [showMenu, setShowMenu] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [loading, setLoading] = useState(false);

  const sendZap = async (amountSats: number) => {
    if (!lud16 || loading) return;

    setLoading(true);
    try {
      const invoice = await resolveLnurlInvoice(lud16, amountSats);
      window.open(`lightning:${invoice}`, '_blank');
      setShowMenu(false);
      setCustomAmount('');
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
