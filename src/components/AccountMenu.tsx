import React, { useEffect, useRef, useState } from 'react';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager, ExtensionManager } from '../nostr/crypto';
import {
  SavedAccount, addAccountFromExtension, forgetAccount, listAccounts, rememberCurrentAccount, switchToAccount
} from '../nostr/accounts';
import { UserProfile } from '../types';
import { formatAddress } from '../utils/helpers';

/** Starts the app over as the chosen account: every page reads it at once */
const restartAs = (account: SavedAccount) => {
  switchToAccount(account);
  window.location.assign('/');
};

/**
 * The other accounts used in this browser, a press away.
 *
 * An extension gives only the key it is set to, so adding a second account
 * from it means switching the extension first. Switching here does not
 * switch the extension back: signing checks the two agree and says so when
 * they do not, rather than putting a note out under the wrong name.
 */
const AccountMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [profiles, setProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const current = CredentialManager.getPublicKey() || '';

  useEffect(() => {
    rememberCurrentAccount();
  }, []);

  useEffect(() => {
    if (!open) return;
    const list = listAccounts();
    setAccounts(list);
    setNote('');
    const keys = list.map(a => a.pubkey);
    setProfiles(new Map(keys.map(k => [k, EventCache.getProfile(k)]).filter(([, p]) => p) as [string, UserProfile][]));
    NostrCore.fetchProfiles(keys).then(found => setProfiles(prev => new Map([...prev, ...found])));

    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const addFromExtension = async () => {
    if (!ExtensionManager.hasExtension()) {
      setNote('No nostr extension found in this browser.');
      return;
    }
    setBusy(true);
    try {
      const result = await addAccountFromExtension();
      if ('already' in result) {
        setNote('The extension is set to an account already here. Switch to another account in the extension, then press this again.');
      } else {
        restartAs(result.added);
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'The extension did not answer.');
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (pubkey: string) => {
    const p = profiles.get(pubkey);
    return p?.display_name || p?.name || formatAddress(pubkey);
  };

  return (
    <div className="account-menu" ref={boxRef}>
      <button
        type="button"
        className="account-menu-toggle"
        onClick={() => setOpen(o => !o)}
        title="Switch or add an account"
        aria-expanded={open}
      >
        ▾
      </button>
      {open && (
        <div className="account-menu-panel" role="menu">
          {accounts.map(account => {
            const picture = profiles.get(account.pubkey)?.picture;
            const here = account.pubkey === current;
            return (
              <div key={account.pubkey} className="account-menu-row">
              <button
                type="button"
                role="menuitem"
                className={`account-menu-item ${here ? 'current' : ''}`}
                disabled={here}
                onClick={() => restartAs(account)}
              >
                {picture
                  ? <img src={picture} alt="" className="account-menu-avatar" />
                  : <span className="account-menu-avatar placeholder">{nameOf(account.pubkey).charAt(0).toUpperCase()}</span>}
                <span className="account-menu-name">{nameOf(account.pubkey)}</span>
                <span className="account-menu-mode">{here ? '✓' : account.mode === 'extension' ? 'extension' : 'key'}</span>
              </button>
              {!here && (
                // The one in use leaves through Logout; the others from here
                <button
                  type="button"
                  className="account-menu-remove"
                  title={`Remove ${nameOf(account.pubkey)} from this browser`}
                  onClick={() => {
                    if (!window.confirm(`Remove ${nameOf(account.pubkey)} from this browser?`)) return;
                    forgetAccount(account.pubkey);
                    setAccounts(listAccounts());
                  }}
                >
                  ✕
                </button>
              )}
              </div>
            );
          })}
          <button
            type="button"
            role="menuitem"
            className="account-menu-add"
            onClick={addFromExtension}
            disabled={busy}
          >
            {busy ? 'Asking the extension…' : '+ Add account from extension'}
          </button>
          {note && <p className="account-menu-note">{note}</p>}
        </div>
      )}
    </div>
  );
};

export default AccountMenu;
