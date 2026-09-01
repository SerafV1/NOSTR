import React, { useEffect, useState } from 'react';
import {
  DEFAULT_LIMITS,
  WalletConnection,
  connectWallet,
  forgetWallet,
  heldWallet,
  setLimits,
  spentToday,
  walletBalanceSats
} from '../nostr/nwc';

/**
 * Connecting a lightning wallet over NIP-47, so a zap is paid from here
 * instead of copied into something else.
 *
 * The connection string carries a key that can spend money. It is kept in
 * this browser and used for nothing but signing requests to the wallet's own
 * relay — but a browser is a browser, so the page says plainly what it is
 * holding, and the two limits below are set before the first payment rather
 * than after a surprise.
 */
const WalletSettings: React.FC = () => {
  const [held, setHeld] = useState<WalletConnection | null>(() => heldWallet());
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alias, setAlias] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [spent, setSpent] = useState(() => spentToday());
  const [perPayment, setPerPayment] = useState(() => String(heldWallet()?.perPayment ?? DEFAULT_LIMITS.perPayment));
  const [perDay, setPerDay] = useState(() => String(heldWallet()?.perDay ?? DEFAULT_LIMITS.perDay));
  const [savedLimits, setSavedLimits] = useState(false);

  useEffect(() => {
    if (!held) return;
    let dropped = false;
    walletBalanceSats()
      .then(sats => { if (!dropped) setBalance(sats); })
      .catch(() => { /* a wallet that will not say is not an error to shout about */ });
    return () => { dropped = true; };
  }, [held]);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { connection, info } = await connectWallet(uri);
      setHeld(connection);
      setAlias(info.alias || null);
      setPerPayment(String(connection.perPayment));
      setPerDay(String(connection.perDay));
      // Out of the field the moment it is used: a spending key has no
      // business sitting in a form somebody may screenshot
      setUri('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not connect that wallet');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    forgetWallet();
    setHeld(null);
    setBalance(null);
    setAlias(null);
    setSpent(0);
  };

  const saveLimits = () => {
    const payment = Math.max(1, Math.floor(Number(perPayment) || 0));
    const day = Math.max(payment, Math.floor(Number(perDay) || 0));
    setLimits({ perPayment: payment, perDay: day });
    setPerPayment(String(payment));
    setPerDay(String(day));
    setHeld(heldWallet());
    setSavedLimits(true);
    setTimeout(() => setSavedLimits(false), 2000);
  };

  return (
    <section className="settings-section">
      <h2>Wallet</h2>
      <p className="settings-hint">
        Connect a lightning wallet with Nostr Wallet Connect (NIP-47) and zaps are paid
        straight from here — no invoice to copy, no extension needed. Alby Hub, Coinos,
        Primal, Mutiny, LNbits and others all hand out a connection string.
      </p>

      {!held ? (
        <>
          <form className="add-relay-form" onSubmit={connect}>
            <div className="relay-input-group">
              <input
                type="password"
                className="relay-input"
                placeholder="nostr+walletconnect://…"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="add-relay-btn" disabled={busy || !uri.trim()}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </form>

          {error && <div className="error-message">{error}</div>}

          <div className="wallet-warning">
            <strong>Before you paste one.</strong> That string lets this browser spend from
            the wallet. Make it in your wallet with a budget on it — a few thousand sats a
            week is plenty for zapping — and never paste one that isn't yours or that
            somebody sent you. Anyone who gets it, including anything that manages to run
            code on this page, can spend up to that budget. Nothing else here is worth as
            much: treat it like the key to a small pocket, not to the vault.
          </div>
        </>
      ) : (
        <>
          <div className="relay-stats">
            <div className="relay-stat">
              <span className="relay-stat-label">Balance</span>
              <span className="relay-stat-value">
                {balance === null ? '—' : `${balance.toLocaleString()} sats`}
              </span>
            </div>
            <div className="relay-stat">
              <span className="relay-stat-label">Spent today</span>
              <span className="relay-stat-value">{spent.toLocaleString()}</span>
            </div>
            <div className="relay-stat">
              <span className="relay-stat-label">Left today</span>
              <span className="relay-stat-value">
                {Math.max(0, held.perDay - spent).toLocaleString()}
              </span>
            </div>
          </div>

          <div className="wallet-connected">
            <div className="wallet-connected-who">
              <span className="wallet-dot" aria-hidden="true">⚡</span>
              <div>
                <div className="wallet-name">{alias || held.lud16 || 'Wallet connected'}</div>
                <div className="wallet-relay">{held.relays[0]}</div>
              </div>
            </div>
            <button type="button" className="wallet-disconnect" onClick={disconnect}>
              Disconnect
            </button>
          </div>

          <div className="wallet-limits">
            <h3>What this browser may spend</h3>
            <p className="settings-hint">
              Checked here before the wallet is asked for anything, so a mistake — or a page
              that has been tampered with — runs into a wall that is not the whole balance.
              The budget you set in the wallet itself is still the one that counts.
            </p>
            <label className="wallet-limit">
              <span>Most per zap</span>
              <input
                type="number"
                min={1}
                value={perPayment}
                onChange={(e) => setPerPayment(e.target.value)}
              />
              <span className="wallet-limit-unit">sats</span>
            </label>
            <label className="wallet-limit">
              <span>Most per day</span>
              <input
                type="number"
                min={1}
                value={perDay}
                onChange={(e) => setPerDay(e.target.value)}
              />
              <span className="wallet-limit-unit">sats</span>
            </label>
            <button type="button" className="add-relay-btn" onClick={saveLimits}>
              {savedLimits ? '✓ Saved' : 'Save limits'}
            </button>
          </div>
        </>
      )}
    </section>
  );
};

export default WalletSettings;
