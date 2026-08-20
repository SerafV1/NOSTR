import React, { useEffect, useState } from 'react';
import { NostrCore } from '../nostr/core';
import { UserProfile } from '../types';
import { formatAddress } from '../utils/helpers';
import EmojiText from './EmojiText';

interface MutedSettingsProps {
  /** Names cannot be looked up before the pool is up — see the effect below */
  relaysConnected: boolean;
}

/**
 * Everyone this account has muted, and the way back.
 *
 * Muting someone from the chat hides what they say — which also hides the
 * name you would have clicked to undo it. Without a list of them somewhere,
 * a mute made in passing could only be undone by finding that person again
 * somewhere else entirely.
 */
const MutedSettings: React.FC<MutedSettingsProps> = ({ relaysConnected }) => {
  const [muted, setMuted] = useState<string[]>(() => [...NostrCore.getBlockedPubkeys()]);
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [working, setWorking] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Landing straight here on a page load, the relay pool has not finished
    // connecting; asking then returns nothing and never asks again, leaving
    // every row as a shortened key
    if (!relaysConnected) return;
    let cancelled = false;

    const loadProfiles = async (list: string[]) => {
      if (!list.length) return;
      const found = await NostrCore.fetchProfiles(list);
      if (!cancelled) setProfiles(current => new Map([...current, ...found]));
    };

    // Names for what is already known locally, without waiting on the list
    // itself to be re-read — that round trip can outlast the visit, and it
    // left every row showing a shortened key
    loadProfiles([...NostrCore.getBlockedPubkeys()]);
    setLoading(false);

    // Then the list as the relays have it, in case it grew on another device
    (async () => {
      const fresh = [...await NostrCore.fetchBlockedPubkeys()];
      if (cancelled) return;
      setMuted(fresh);
      loadProfiles(fresh);
    })();

    return () => { cancelled = true; };
  }, [relaysConnected]);

  const unmute = async (pubkey: string) => {
    setWorking(pubkey);
    try {
      await NostrCore.unblockUser(pubkey);
      setMuted(current => current.filter(p => p !== pubkey));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not unmute this account');
    } finally {
      setWorking(null);
    }
  };

  if (loading && muted.length === 0) {
    return <div className="loading">Loading your mute list…</div>;
  }

  if (muted.length === 0) {
    return (
      <div className="empty-state">
        <p>Nobody is muted. Muting someone hides their posts and their messages in stream chats, on every device you use this account on.</p>
      </div>
    );
  }

  return (
    <div className="muted-list">
      {muted.map(pubkey => {
        const profile = profiles.get(pubkey);
        const name = profile?.display_name || profile?.name || formatAddress(pubkey);
        return (
          <div key={pubkey} className="muted-row">
            <span className="muted-person">
              {profile?.picture ? (
                <img src={profile.picture} alt="" className="muted-avatar" />
              ) : (
                <span className="muted-avatar-placeholder">{name.charAt(0).toUpperCase()}</span>
              )}
              <span className="muted-name">
                <EmojiText text={name} emojis={profile?.emojis} />
              </span>
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={working === pubkey}
              onClick={() => unmute(pubkey)}
            >
              {working === pubkey ? '…' : 'Unmute'}
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default MutedSettings;
