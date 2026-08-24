import React, { useEffect, useState } from 'react';
import { NostrCore } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { NO_CONTACT_LIST_PROMPT } from '../utils/followPrompt';

interface FollowButtonProps {
  pubkey: string;
  className?: string;
}

/**
 * Follow or unfollow, wherever a person is named.
 *
 * The follow list this account already keeps locally answers at once; the
 * relays are only asked when it has nothing to say, because that round trip
 * took long enough that a button sat there offering to follow someone who was
 * already followed.
 *
 * Nothing is drawn for your own account: there is no following yourself.
 */
const FollowButton: React.FC<FollowButtonProps> = ({ pubkey, className }) => {
  const isOwnAccount = pubkey === CredentialManager.getPublicKey();
  const [following, setFollowing] = useState<boolean | null>(
    () => (NostrCore.getCachedFollowedAccounts().includes(pubkey) ? true : null)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOwnAccount || following !== null) return;
    let cancelled = false;
    NostrCore.isFollowing(pubkey).then(result => {
      if (!cancelled) setFollowing(result);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, isOwnAccount]);

  if (isOwnAccount || !CredentialManager.isLoggedIn()) return null;

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || following === null) return;
    setBusy(true);
    setError(null);
    try {
      if (following) {
        await NostrCore.unfollowUser(pubkey);
        setFollowing(false);
        return;
      }

      try {
        await NostrCore.followUser(pubkey);
      } catch (err) {
        // Publishing a first contact list would replace whatever the relays
        // failed to hand over, so it is asked for rather than assumed
        if (err instanceof Error && err.message === NostrCore.NO_EXISTING_CONTACT_LIST) {
          if (!window.confirm(NO_CONTACT_LIST_PROMPT)) return;
          await NostrCore.followUser(pubkey, { createIfMissing: true });
        } else {
          throw err;
        }
      }
      setFollowing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update follow list');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={className || 'btn btn-secondary btn-small'}
      onClick={toggle}
      disabled={busy || following === null}
      title={error || (following ? 'Unfollow' : 'Follow')}
    >
      {/* "Unfollow", as the hover card and the profile page both say — the
          button names what pressing it does, not the state it reports */}
      {following === null ? '…' : busy ? '…' : following ? 'Unfollow' : 'Follow'}
    </button>
  );
};

export default FollowButton;
