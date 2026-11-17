import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NostrCore, EventCache } from '../nostr/core';
import { getRelayPool } from '../nostr/relay';
import { EVENT_KINDS, NostrEventSigned, UserProfile } from '../types';
import { TIP_ADDRESS, TIP_PUBKEY } from '../utils/tip';
import { usePageMeta } from '../hooks/usePageMeta';
import ZapButton from './ZapButton';
import Pic from './Pic';
import EmojiText from './EmojiText';
import { ZapIcon } from './Icons';
import { formatAddress } from '../utils/helpers';

interface Payment {
  id: string;
  sender: string | null;
  sats: number;
  comment: string;
  at: number;
}

const ago = (seconds: number): string => {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
};

/**
 * The people keeping RAZR going, and what they sent.
 *
 * Read from the zap receipts the wallet publishes, so it is the same record
 * every nostr client sees — nothing here is kept by RAZR itself. A tip paid
 * without a nostr identity shows as anonymous.
 */
const SupportersPage: React.FC<{ relaysConnected: boolean; onNavigateToProfile: (pubkey: string) => void }> = ({
  relaysConnected, onNavigateToProfile
}) => {
  usePageMeta({
    title: 'Supporters',
    description: 'The people supporting RAZR, a nostr client, and the zaps they sent.'
  });
  const navigate = useNavigate();
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [razr, setRazr] = useState<UserProfile | null>(() => EventCache.getProfile(TIP_PUBKEY) || null);
  const [thanks, setThanks] = useState<number | null>(null);

  const load = useCallback(async () => {
    const receipts: NostrEventSigned[] = await getRelayPool().fetchEvents(
      [{ kinds: [EVENT_KINDS.ZAP_RECEIPT], '#p': [TIP_PUBKEY], limit: 1000 }],
      true
    );
    const seen = new Set<string>();
    const list: Payment[] = [];
    for (const receipt of receipts) {
      if (seen.has(receipt.id)) continue;
      seen.add(receipt.id);
      // A zap on a note of RAZR's still names it; only payments to it count
      if (NostrCore.zapRecipientPubkey(receipt) !== TIP_PUBKEY) continue;
      const sats = NostrCore.parseZapAmountSats(receipt);
      if (sats <= 0) continue;
      list.push({
        id: receipt.id,
        sender: NostrCore.zapSenderPubkey(receipt),
        sats,
        comment: NostrCore.zapComment(receipt),
        at: receipt.created_at
      });
    }
    list.sort((a, b) => b.at - a.at);
    setPayments(list);

    const people = Array.from(new Set(list.map(p => p.sender).filter((p): p is string => !!p)));
    const found = await NostrCore.fetchProfiles([...people, TIP_PUBKEY]);
    setProfiles(found);
    const own = found.get(TIP_PUBKEY);
    if (own) setRazr(own);
  }, []);

  useEffect(() => {
    if (!relaysConnected) return;
    load().catch(() => setPayments(current => current || []));
  }, [relaysConnected, load]);

  const supporters = useMemo(() => {
    const byPerson = new Map<string, { pubkey: string | null; sats: number; count: number }>();
    for (const payment of payments || []) {
      const key = payment.sender || 'anonymous';
      const held = byPerson.get(key) || { pubkey: payment.sender, sats: 0, count: 0 };
      held.sats += payment.sats;
      held.count += 1;
      byPerson.set(key, held);
    }
    return Array.from(byPerson.values()).sort((a, b) => b.sats - a.sats);
  }, [payments]);

  const total = (payments || []).reduce((sum, p) => sum + p.sats, 0);

  const person = (pubkey: string | null, size: number) => {
    const profile = pubkey ? profiles.get(pubkey) || EventCache.getProfile(pubkey) : undefined;
    const name = pubkey ? profile?.display_name || profile?.name || formatAddress(pubkey) : 'Anonymous';
    return (
      <button
        type="button"
        className="supporter-person"
        disabled={!pubkey}
        onClick={() => pubkey && onNavigateToProfile(pubkey)}
      >
        {profile?.picture
          ? <Pic src={profile.picture} className="supporter-avatar" width={size} height={size} />
          : <span className="supporter-avatar placeholder" style={{ width: size, height: size }}>{name.charAt(0).toUpperCase()}</span>}
        <span className="supporter-name"><EmojiText text={name} emojis={profile?.emojis} /></span>
      </button>
    );
  };

  return (
    <div className="supporters-page">
      <section className="supporters-hero">
        {razr?.picture && <Pic src={razr.picture} className="supporters-logo" width={72} height={72} />}
        <h2>Support RAZR</h2>
        <p>
          RAZR is free, open and made by one person. Every zap goes straight to
          the project's wallet and keeps it growing — and puts your name on this page.
        </p>
        <ZapButton
          lud16={TIP_ADDRESS}
          recipientPubkey={TIP_PUBKEY}
          recipientName={razr?.display_name || razr?.name || 'RAZR'}
          recipientPicture={razr?.picture}
          recipientEmojis={razr?.emojis}
          triggerClassName="btn btn-primary btn-with-icon supporters-tip"
          triggerTitle="Zap RAZR"
          onPaid={(sats) => {
            setThanks(sats);
            // The wallet publishes the receipt a moment after paying
            setTimeout(() => { load().catch(() => {}); }, 4000);
          }}
        >
          <ZapIcon /> Tip RAZR
        </ZapButton>
        {thanks !== null && <p className="supporters-thanks">Thank you for the {thanks.toLocaleString()} sats! ⚡</p>}
        <div className="supporters-stats">
          <div><strong>{total.toLocaleString()}</strong><span>sats received</span></div>
          <div><strong>{supporters.length}</strong><span>supporters</span></div>
          <div><strong>{(payments || []).length}</strong><span>zaps</span></div>
        </div>
      </section>

      {payments === null ? (
        <p className="supporters-note">Reading the zaps…</p>
      ) : payments.length === 0 ? (
        <p className="supporters-note">No zaps yet. Be the first name on this page.</p>
      ) : (
        <div className="supporters-columns">
          <section className="sidebar-card">
            <h3>Top supporters</h3>
            <ol className="supporters-top">
              {supporters.slice(0, 20).map((s, i) => (
                <li key={s.pubkey || 'anonymous'}>
                  <span className="supporters-rank">{i + 1}</span>
                  {person(s.pubkey, 32)}
                  <span className="supporters-sats">⚡ {s.sats.toLocaleString()}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="sidebar-card">
            <h3>Recent zaps</h3>
            <ul className="supporters-recent">
              {payments.slice(0, 100).map(p => (
                <li key={p.id}>
                  <div className="supporters-recent-head">
                    {person(p.sender, 28)}
                    <span className="supporters-sats">⚡ {p.sats.toLocaleString()}</span>
                  </div>
                  {p.comment && <p className="supporters-comment">{p.comment}</p>}
                  <span className="supporters-time">{ago(p.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <p className="supporters-note">
        Lightning address: <code>{TIP_ADDRESS}</code> ·{' '}
        <button type="button" className="link-button" onClick={() => navigate(`/p/${TIP_PUBKEY}`)}>RAZR on nostr</button>
      </p>
    </div>
  );
};

export default SupportersPage;
