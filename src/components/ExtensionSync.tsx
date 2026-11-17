import React, { useEffect, useRef, useState } from 'react';
import { CredentialManager, ExtensionManager, NostrWindow } from '../nostr/crypto';
import { EventCache, NostrCore } from '../nostr/core';
import { awaitedExtensionAccount, followExtensionTo, stopAwaitingExtension } from '../nostr/accounts';
import { formatAddress } from '../utils/helpers';

type Listening = { on?: (event: string, handler: () => void) => void; off?: (event: string, handler: () => void) => void };

/**
 * Keeps the account in use here and the one the extension is set to the same.
 *
 * Switched in the extension: noticed when the page is come back to (and at
 * once, for an extension that announces it), and followed — added to the
 * account list if it is new.
 *
 * Switched here: a page has no way to switch an extension, so this says
 * which account to switch it to, and goes quiet once the two agree.
 */
const ExtensionSync: React.FC = () => {
  const [mismatch, setMismatch] = useState<{ wanted: string; extension: string } | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const checking = useRef(false);

  useEffect(() => {
    if (!ExtensionManager.hasExtension()) return;

    const check = async () => {
      if (checking.current || !CredentialManager.isExtensionMode()) return;
      checking.current = true;
      try {
        const extension = await ExtensionManager.getPublicKey(8000).catch(() => null);
        const current = CredentialManager.getPublicKey();
        if (!extension || !current) return;
        const awaited = awaitedExtensionAccount();

        if (extension === current) {
          if (awaited) stopAwaitingExtension();
          setMismatch(null);
          return;
        }
        if (awaited === current) {
          // Chosen here; waiting for the extension to be switched to it
          setMismatch({ wanted: current, extension });
          return;
        }
        followExtensionTo(extension);
        window.location.reload();
      } finally {
        checking.current = false;
      }
    };

    check();
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    // Alby, among others, says when its account changes; most say nothing
    const nostr = (window as NostrWindow).nostr as unknown as Listening | undefined;
    if (typeof nostr?.on === 'function') nostr.on('accountChanged', check);
    // A popup that does not take focus from the page leaves nothing to hear
    const interval = setInterval(() => { if (document.visibilityState === 'visible') check(); }, 15000);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
      if (typeof nostr?.off === 'function') nostr.off('accountChanged', check);
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!mismatch) return;
    const keys = [mismatch.wanted, mismatch.extension];
    const label = (k: string) => {
      const p = EventCache.getProfile(k);
      return p?.display_name || p?.name || formatAddress(k);
    };
    setNames(Object.fromEntries(keys.map(k => [k, label(k)])));
    NostrCore.fetchProfiles(keys).then(found => {
      setNames(Object.fromEntries(keys.map(k => {
        const p = found.get(k);
        return [k, p?.display_name || p?.name || label(k)];
      })));
    }).catch(() => {});
  }, [mismatch]);

  if (!mismatch) return null;
  return (
    <div className="extension-sync-banner">
      <span>
        Switch your extension to <strong>{names[mismatch.wanted] || formatAddress(mismatch.wanted)}</strong> to post
        as this account — it is set to <strong>{names[mismatch.extension] || formatAddress(mismatch.extension)}</strong>.
      </span>
      <button
        type="button"
        className="btn btn-secondary btn-small"
        onClick={() => { followExtensionTo(mismatch.extension); window.location.reload(); }}
      >
        Use {names[mismatch.extension] || 'that account'} instead
      </button>
    </div>
  );
};

export default ExtensionSync;
