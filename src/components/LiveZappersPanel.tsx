import React, { useEffect, useState } from 'react';
import { NostrEventSigned, UserProfile, EVENT_KINDS } from '../types';
import { NostrCore } from '../nostr/core';
import { formatAddress } from '../utils/helpers';
import EmojiText from './EmojiText';

interface LiveZappersPanelProps {
  address: string;
  relaysConnected?: boolean;
  /** How many to list before the rest are left off */
  limit?: number;
  onNavigateToProfile?: (pubkey: string) => void;
  /** Shown in the header of the standalone window, as the chat's is */
  headerAction?: React.ReactNode;
  /** Hidden in an overlay, where a heading is just something to capture */
  hideHeader?: boolean;
  /** Beside the chat there is no room for an empty box taking up the view */
  hideWhenEmpty?: boolean;
}

interface Zapper {
  pubkey: string;
  sats: number;
  zaps: number;
}

/**
 * Who has zapped this stream, most sats first.
 *
 * The receipts are the same ones the chat already shows as they arrive; here
 * they are added up per person instead, which is the part a streamer wants on
 * screen. Each row reads like the zap lines in the chat, since it is the same
 * event being shown a second way.
 */
const LiveZappersPanel: React.FC<LiveZappersPanelProps> = ({
  address,
  relaysConnected = true,
  limit = 10,
  onNavigateToProfile,
  headerAction,
  hideHeader,
  hideWhenEmpty
}) => {
  const [zaps, setZaps] = useState<NostrEventSigned[]>([]);
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());

  useEffect(() => {
    if (!relaysConnected) return;
    let cancelled = false;

    const remember = (events: NostrEventSigned[]) => {
      setZaps(prev => {
        const byId = new Map(prev.map(e => [e.id, e]));
        for (const event of events) byId.set(event.id, event);
        return [...byId.values()];
      });
    };

    (async () => {
      const history = await NostrCore.fetchLiveZaps(address);
      if (cancelled) return;
      remember(history);

      const senders = history
        .map(zap => NostrCore.zapSenderPubkey(zap))
        .filter((pubkey): pubkey is string => !!pubkey);
      if (senders.length) {
        const found = await NostrCore.fetchProfiles(senders);
        if (!cancelled) setProfiles(found);
      }
    })();

    const subId = NostrCore.subscribeLive(
      [{ kinds: [EVENT_KINDS.ZAP_RECEIPT], '#a': [address] }],
      async (event) => {
        if (!NostrCore.zapIsShowable(event)) return;
        remember([event]);
        const sender = NostrCore.zapSenderPubkey(event);
        if (sender) {
          const found = await NostrCore.fetchProfiles([sender]);
          if (!cancelled) setProfiles(prev => new Map([...prev, ...found]));
        }
      }
    );

    return () => {
      cancelled = true;
      NostrCore.unsubscribeLive(subId);
    };
  }, [address, relaysConnected]);

  const zappers: Zapper[] = (() => {
    const totals = new Map<string, Zapper>();
    for (const zap of zaps) {
      const sender = NostrCore.zapSenderPubkey(zap);
      if (!sender) continue;
      const sats = NostrCore.parseZapAmountSats(zap);
      const held = totals.get(sender);
      if (held) {
        held.sats += sats;
        held.zaps += 1;
      } else {
        totals.set(sender, { pubkey: sender, sats, zaps: 1 });
      }
    }
    return [...totals.values()].sort((a, b) => b.sats - a.sats).slice(0, limit);
  })();

  if (hideWhenEmpty && zappers.length === 0) return null;

  return (
    <div className="live-zappers-panel">
      {!hideHeader && (
        <div className="live-zappers-header">
          <span>⚡ Top zappers</span>
          {headerAction}
        </div>
      )}

      <div className="live-zappers-list">
        {zappers.length === 0 && (
          <div className="live-chat-empty">No zaps yet</div>
        )}
        {zappers.map((zapper, index) => {
          const profile = profiles.get(zapper.pubkey);
          const name = profile?.display_name || profile?.name || formatAddress(zapper.pubkey);
          return (
            <div key={zapper.pubkey} className="live-zapper">
              <span className="live-zapper-rank">{index + 1}</span>
              {profile?.picture ? (
                <img src={profile.picture} alt="" className="live-chat-avatar" />
              ) : (
                <div className="live-chat-avatar-placeholder">{name.charAt(0).toUpperCase()}</div>
              )}
              <button
                type="button"
                className="live-chat-author live-zapper-name"
                onClick={() => onNavigateToProfile?.(zapper.pubkey)}
              >
                <EmojiText text={name} emojis={profile?.emojis} />
              </button>
              <span className="live-zapper-sats">
                ⚡ {zapper.sats.toLocaleString()}
                {zapper.zaps > 1 && <span className="live-zapper-count"> ×{zapper.zaps}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default LiveZappersPanel;
