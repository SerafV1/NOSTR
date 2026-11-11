import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import EmojiText from './EmojiText';
import Nip05Handle from './Nip05Handle';
import { UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { formatAddress } from '../utils/helpers';
import { NO_CONTACT_LIST_PROMPT } from '../utils/followPrompt';
import Pic from './Pic';

interface ProfileHoverCardProps {
  pubkey: string;
  /** Known profile, if the caller already has one — saves a lookup */
  profile?: UserProfile | null;
  onNavigateToProfile: (pubkey: string) => void;
  /** Called after a mute, so the surrounding feed can drop the author */
  onBlocked?: (pubkey: string) => void;
  children: React.ReactNode;
}

/**
 * When the follow list was last read from the relays, shared by every card.
 * Each hover asking again meant a round trip per name pointed at, for a list
 * that changes rarely.
 */
let followListCheckedAt = 0;
const FOLLOW_LIST_STALE_MS = 60_000;

// Long enough that brushing past a name doesn't flash a card, short enough
// that deliberately resting on one feels immediate
const OPEN_DELAY_MS = 400;
// Leaving the name to reach the card crosses a small gap — don't close in it
const CLOSE_DELAY_MS = 200;

/**
 * Wraps an author's avatar/name and shows an actions popover on hover:
 * follow, unfollow, mute, unmute. Everything is loaded lazily, on the
 * first open, so a feed of 100 cards costs nothing until you point at one.
 */
const ProfileHoverCard: React.FC<ProfileHoverCardProps> = ({
  pubkey,
  profile: knownProfile,
  onNavigateToProfile,
  onBlocked,
  children
}) => {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(knownProfile || EventCache.getProfile(pubkey));
  // The follow list this account already keeps locally answers instantly;
  // asking the relays took long enough that the card sat there offering to
  // follow someone already followed
  const [isFollowing, setIsFollowing] = useState<boolean | null>(
    () => NostrCore.followsFromCache(pubkey)
  );
  const [blocked, setBlocked] = useState(() => NostrCore.isBlocked(pubkey));
  const [busy, setBusy] = useState<'follow' | 'block' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placeAbove, setPlaceAbove] = useState(false);
  const [fixedStyle, setFixedStyle] = useState<React.CSSProperties | undefined>(undefined);

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  /**
   * When the reader last followed, unfollowed, muted or unmuted from here.
   *
   * The relays are asked whether this person is followed whenever the card
   * opens, and on a slow answer that question is still in the air when the
   * button is pressed. Arriving afterwards, it overwrote what had just been
   * done: the card flipped back to "Follow" a second after the follow was
   * published, which reads as the press having been ignored.
   */
  const actedAt = useRef(0);
  /** Readable from a timer, which cannot see the state */
  const busyRef = useRef<null | 'follow' | 'block'>(null);

  const isOwnProfile = pubkey === CredentialManager.getPublicKey();

  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (knownProfile) setProfile(knownProfile);
  }, [knownProfile]);

  // Only once the card is actually opened: fill in whatever we don't know
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    if (!profile) {
      NostrCore.fetchUserProfile(pubkey).then(p => {
        if (!cancelled && p) setProfile(p);
      });
    }
    // The local list answers at once; the relays are asked only when it had
    // nothing to say, or when what it says has not been checked in a while
    const stale = Date.now() - followListCheckedAt > FOLLOW_LIST_STALE_MS;
    if (!isOwnProfile && (isFollowing === null || stale)) {
      followListCheckedAt = Date.now();
      const askedAt = Date.now();
      NostrCore.isFollowing(pubkey).then(result => {
        if (cancelled) return;
        // Asked before the reader pressed anything, so it describes how
        // things were rather than how they are, however late it arrives
        if (askedAt <= actedAt.current) return;
        setIsFollowing(result);
      });
    }

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pubkey]);

  /**
   * Where the card goes. Always fixed to the viewport, because it is drawn
   * at the end of the page rather than inside the post it belongs to.
   *
   * `top` and `bottom` are both set every time: the stylesheet gives the
   * card a `top` of its own, and leaving the inline one out let that one
   * apply alongside the `bottom` here, which stretched the card down the
   * whole window.
   */
  const placeFixed = (rect: DOMRect) => {
    const width = 280;
    const margin = 8;
    const below = window.innerHeight - rect.bottom >= 320;
    setFixedStyle({
      position: 'fixed',
      width,
      left: Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin),
      top: below ? rect.bottom + margin : 'auto',
      bottom: below ? 'auto' : window.innerHeight - rect.top + margin
    });
  };


  const scheduleOpen = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (open) return;
    openTimer.current = setTimeout(() => {
      // Near the bottom of the viewport the card would hang off-screen —
      // flip it above the name instead
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (rect) {
        setPlaceAbove(window.innerHeight - rect.bottom < 320);
        placeFixed(rect);
      }
      setOpen(true);
    }, OPEN_DELAY_MS);
  };

  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    // Not while it is still doing what it was asked: a press that fails has
    // its reason printed on the card, and closing on the way out threw that
    // away — leaving nothing to say why the follow did not happen
    const closeWhenIdle = () => {
      if (busyRef.current) {
        closeTimer.current = setTimeout(closeWhenIdle, CLOSE_DELAY_MS);
        return;
      }
      setOpen(false);
    };
    closeTimer.current = setTimeout(closeWhenIdle, CLOSE_DELAY_MS);
  };

  /** Kept in a ref as well, so a timer can see whether anything is happening */
  const markBusy = (what: null | 'follow' | 'block') => {
    busyRef.current = what;
    setBusy(what);
  };

  const handleFollowToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || isFollowing === null) return;
    markBusy('follow');
    setError(null);
    // Answered on the card at once; the list is rewritten underneath, and
    // the card goes back to what it said if that does not happen
    actedAt.current = Date.now();
    const was = isFollowing;
    setIsFollowing(!isFollowing);
    try {
      // Taken, or not taken: these answer `false` when no relay would have
      // the list, which is a failure as surely as a thrown error and was
      // being read as success — the card went on saying the thing had
      // happened while the relays held nothing of the sort
      let saved: boolean;
      if (was) {
        saved = await NostrCore.unfollowUser(pubkey);
      } else {
        try {
          saved = await NostrCore.followUser(pubkey);
        } catch (err) {
          if (err instanceof Error && err.message === NostrCore.NO_EXISTING_CONTACT_LIST) {
            if (!window.confirm(NO_CONTACT_LIST_PROMPT)) { setIsFollowing(was); return; }
            saved = await NostrCore.followUser(pubkey, { createIfMissing: true });
          } else {
            throw err;
          }
        }
      }
      if (!saved) throw new Error('No relay would take the change — try again in a moment');
    } catch (err) {
      setIsFollowing(was);
      setError(err instanceof Error ? err.message : 'Failed to update follow list');
    } finally {
      markBusy(null);
    }
  };

  const handleBlockToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    actedAt.current = Date.now();
    markBusy('block');
    setError(null);
    try {
      if (blocked) {
        if (!await NostrCore.unblockUser(pubkey)) {
          throw new Error('No relay would take the change — try again in a moment');
        }
        setBlocked(false);
      } else {
        if (!await NostrCore.blockUser(pubkey)) {
          throw new Error('No relay would take the change — try again in a moment');
        }
        setBlocked(true);
        setOpen(false);
        onBlocked?.(pubkey);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update your mute list');
    } finally {
      markBusy(null);
    }
  };

  const displayName = profile?.display_name || profile?.name || formatAddress(pubkey);
  const handle = profile?.nip05 || formatAddress(pubkey);

  return (
    <span
      className="hover-card-wrapper"
      ref={wrapperRef}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      {children}

      {/* Drawn at the end of the page rather than inside the post.
          A card carries `content-visibility: auto`, which brings layout
          containment with it — and that makes the post both a containing
          block and a stacking context of its own. A popover inside one is
          therefore trapped in it however high its z-index: measured on a
          thread, the card reached 55px past the bottom of the post it
          belonged to and the next reply, a stacking context in its turn,
          was painted straight over the part that stuck out. */}
      {open && createPortal(
        <div
          className={`profile-hover-card ${placeAbove ? 'above' : ''}`}
          style={fixedStyle}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="hover-card-identity"
            onClick={() => onNavigateToProfile(pubkey)}
          >
            {profile?.picture ? (
              <Pic src={profile.picture} className="hover-card-avatar" width={56} height={56} />
            ) : (
              <span className="hover-card-avatar-placeholder">{displayName.charAt(0).toUpperCase()}</span>
            )}
            <span className="hover-card-names">
              <span className="hover-card-name"><EmojiText text={displayName} emojis={profile?.emojis} /></span>
              <span className="hover-card-handle">
                {profile?.nip05
                  ? <Nip05Handle nip05={profile.nip05} pubkey={pubkey} />
                  : handle}
              </span>
            </span>
          </button>

          {profile?.about && <p className="hover-card-about">{profile.about}</p>}

          {!isOwnProfile && (
            <div className="hover-card-actions">
              <button
                type="button"
                className={`hover-card-btn ${isFollowing ? 'secondary' : 'primary'}`}
                onClick={handleFollowToggle}
                disabled={busy !== null || isFollowing === null}
              >
                {/* Not yet known is its own state: offering "Follow" while
                    the answer is still coming was wrong half the time */}
                {isFollowing === null ? '…' : isFollowing ? 'Unfollow' : 'Follow'}
              </button>
              <button
                type="button"
                className="hover-card-btn danger"
                onClick={handleBlockToggle}
                disabled={busy !== null}
              >
                {busy === 'block' ? '...' : blocked ? 'Unmute' : 'Mute'}
              </button>
            </div>
          )}

          {error && <p className="hover-card-error">{error}</p>}
        </div>,
        document.body
      )}
    </span>
  );
};

export default ProfileHoverCard;
