import React, { useEffect, useRef, useState } from 'react';
import { UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { formatAddress } from '../utils/helpers';
import { NO_CONTACT_LIST_PROMPT } from '../utils/followPrompt';

interface ProfileHoverCardProps {
  pubkey: string;
  /** Known profile, if the caller already has one — saves a lookup */
  profile?: UserProfile | null;
  onNavigateToProfile: (pubkey: string) => void;
  /** Called after a mute, so the surrounding feed can drop the author */
  onBlocked?: (pubkey: string) => void;
  /**
   * Open on click as well as on hover. For places where the name is there to
   * be acted on rather than read past — and where hovering may not be
   * available at all.
   */
  openOnClick?: boolean;
  /**
   * Draw the card fixed to the viewport instead of inside the flow. For
   * places that clip their overflow — the chat panel cuts anything reaching
   * past its edge, card included.
   */
  escapesClipping?: boolean;
  /**
   * One more action for the card, for a mute that is not the account's own
   * list — a stream's list, say, which only its owner can undo.
   */
  extraAction?: { label: string; onClick: () => void | Promise<void> };
  /** Dropped where the card is opened to undo a mute — following is not why
   *  anyone opens it there */
  hideFollow?: boolean;
  children: React.ReactNode;
}

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
  openOnClick,
  escapesClipping,
  extraAction,
  hideFollow,
  children
}) => {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(knownProfile || EventCache.getProfile(pubkey));
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [blocked, setBlocked] = useState(() => NostrCore.isBlocked(pubkey));
  const [busy, setBusy] = useState<'follow' | 'block' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placeAbove, setPlaceAbove] = useState(false);
  const [fixedStyle, setFixedStyle] = useState<React.CSSProperties | undefined>(undefined);

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);

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
    if (isFollowing === null && !isOwnProfile) {
      NostrCore.isFollowing(pubkey).then(result => {
        if (!cancelled) setIsFollowing(result);
      });
    }

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pubkey]);

  /** Where the card goes when it has to escape a clipping container */
  const placeFixed = (rect: DOMRect) => {
    const width = 280;
    const margin = 8;
    const below = window.innerHeight - rect.bottom >= 320;
    setFixedStyle({
      position: 'fixed',
      width,
      left: Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin),
      top: below ? rect.bottom + margin : undefined,
      bottom: below ? undefined : window.innerHeight - rect.top + margin
    });
  };

  /** Straight away, skipping the delay meant for a pointer passing by */
  const openNow = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (rect) {
      setPlaceAbove(window.innerHeight - rect.bottom < 320);
      if (escapesClipping) placeFixed(rect);
    }
    setOpen(current => !current);
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
        if (escapesClipping) placeFixed(rect);
      }
      setOpen(true);
    }, OPEN_DELAY_MS);
  };

  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  const handleFollowToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || isFollowing === null) return;
    setBusy('follow');
    setError(null);
    try {
      if (isFollowing) {
        await NostrCore.unfollowUser(pubkey);
        setIsFollowing(false);
      } else {
        try {
          await NostrCore.followUser(pubkey);
        } catch (err) {
          if (err instanceof Error && err.message === NostrCore.NO_EXISTING_CONTACT_LIST) {
            if (!window.confirm(NO_CONTACT_LIST_PROMPT)) return;
            await NostrCore.followUser(pubkey, { createIfMissing: true });
          } else {
            throw err;
          }
        }
        setIsFollowing(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update follow list');
    } finally {
      setBusy(null);
    }
  };

  const handleBlockToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy('block');
    setError(null);
    try {
      if (blocked) {
        await NostrCore.unblockUser(pubkey);
        setBlocked(false);
      } else {
        await NostrCore.blockUser(pubkey);
        setBlocked(true);
        setOpen(false);
        onBlocked?.(pubkey);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update your mute list');
    } finally {
      setBusy(null);
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
      onClick={openOnClick ? (e) => { e.stopPropagation(); openNow(); } : undefined}
    >
      {children}

      {open && (
        <div
          className={`profile-hover-card ${placeAbove ? 'above' : ''}`}
          style={fixedStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="hover-card-identity"
            onClick={() => onNavigateToProfile(pubkey)}
          >
            {profile?.picture ? (
              <img src={profile.picture} alt="" className="hover-card-avatar" />
            ) : (
              <span className="hover-card-avatar-placeholder">{displayName.charAt(0).toUpperCase()}</span>
            )}
            <span className="hover-card-names">
              <span className="hover-card-name">{displayName}</span>
              <span className="hover-card-handle">{handle}</span>
            </span>
          </button>

          {profile?.about && <p className="hover-card-about">{profile.about}</p>}

          {!isOwnProfile && (
            <div className="hover-card-actions">
              {!hideFollow && (
                <button
                  type="button"
                  className={`hover-card-btn ${isFollowing ? 'secondary' : 'primary'}`}
                  onClick={handleFollowToggle}
                  disabled={busy !== null || isFollowing === null}
                >
                  {busy === 'follow' ? '...' : isFollowing === null ? 'Follow' : isFollowing ? 'Unfollow' : 'Follow'}
                </button>
              )}
              <button
                type="button"
                className="hover-card-btn danger"
                onClick={handleBlockToggle}
                disabled={busy !== null}
              >
                {busy === 'block' ? '...' : blocked ? 'Unmute' : 'Mute'}
              </button>
              {extraAction && (
                <button
                  type="button"
                  className="hover-card-btn secondary"
                  onClick={() => extraAction.onClick()}
                  disabled={busy !== null}
                >
                  {extraAction.label}
                </button>
              )}
            </div>
          )}

          {error && <p className="hover-card-error">{error}</p>}
        </div>
      )}
    </span>
  );
};

export default ProfileHoverCard;
