import React, { useRef, useState } from 'react';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { getRelayPool } from '../nostr/relay';
import { UserProfile } from '../types';

interface AccountBackup {
  app: string;
  kind: string;
  savedAt: string;
  pubkey: string;
  profile?: Partial<UserProfile>;
  follows?: string[];
  muted?: string[];
  relays?: { url: string; read: boolean; write: boolean }[];
}

/**
 * A copy of what this account is, and a way to put it back.
 *
 * Nothing here is the key — a backup that carried the key would be a file
 * that can post as you, and one saved to the wrong place would be the end of
 * the account. This is what the key *says*: the profile, who it follows, who
 * it has muted, and the relays it reaches them through.
 *
 * All of those are replaceable events, so putting one back means publishing
 * over whatever the relays currently hold. Restoring therefore adds to what
 * is there rather than replacing it: a file from a month ago should not
 * unfollow everyone met since.
 */
const BackupSettings: React.FC = () => {
  const [busy, setBusy] = useState<'saving' | 'restoring' | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<AccountBackup | null>(null);
  const [restore, setRestore] = useState({ profile: true, follows: true, muted: true, relays: true });
  const fileInput = useRef<HTMLInputElement>(null);

  const pubkey = CredentialManager.getPublicKey();

  const handleBackup = async () => {
    if (!pubkey) return;
    setBusy('saving');
    setError(null);
    setSaid(null);
    try {
      const [profile, follows, muted] = await Promise.all([
        NostrCore.fetchUserProfile(pubkey).catch(() => EventCache.getProfile(pubkey) || null),
        NostrCore.readFollowList(),
        NostrCore.readMuteList()
      ]);

      const peopleIn = (list: { tags: string[][] } | null) =>
        (list?.tags || []).filter(t => t[0] === 'p' && t[1]).map(t => t[1]);

      const backup: AccountBackup = {
        app: 'razr',
        kind: 'account',
        savedAt: new Date().toISOString(),
        pubkey,
        // The key itself is deliberately not here
        profile: profile ? { ...profile, pubkey: undefined } : undefined,
        follows: peopleIn(follows),
        muted: peopleIn(muted),
        relays: getRelayPool().getRelayConfigs().map(config => ({
          url: config.url,
          read: config.read !== false,
          write: config.write !== false
        }))
      };

      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `razr-account-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setSaid(
        `Saved: profile, ${backup.follows?.length ?? 0} follows, `
        + `${backup.muted?.length ?? 0} muted, ${backup.relays?.length ?? 0} relays`
      );
    } catch (err) {
      console.error('Backup failed:', err);
      setError(err instanceof Error ? err.message : 'Could not read your lists to save them');
    } finally {
      setBusy(null);
    }
  };

  const handleChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    setError(null);
    setSaid(null);
    try {
      const parsed = JSON.parse(await chosen.text()) as AccountBackup;
      if (parsed.kind !== 'account' || !parsed.pubkey) {
        setError('That file is not an account backup');
        return;
      }
      setFile(parsed);
    } catch {
      setError('That file could not be read');
    }
  };

  const handleRestore = async () => {
    if (!file) return;
    setBusy('restoring');
    setError(null);
    setSaid(null);
    const done: string[] = [];
    try {
      if (restore.profile && file.profile) {
        await NostrCore.publishProfile(file.profile);
        done.push('profile');
      }
      if (restore.follows && file.follows?.length) {
        const added = await NostrCore.restoreFollows(file.follows);
        done.push(`${added} follows added`);
      }
      if (restore.muted && file.muted?.length) {
        const added = await NostrCore.restoreMutes(file.muted);
        done.push(`${added} muted added`);
      }
      if (restore.relays && file.relays?.length) {
        const pool = getRelayPool();
        const already = new Set(pool.getRelayConfigs().map(c => c.url.replace(/\/$/, '')));
        let added = 0;
        for (const relay of file.relays) {
          const url = relay.url.replace(/\/$/, '');
          if (already.has(url)) pool.updateRelayCapabilities(url, relay.read, relay.write);
          else if (await pool.addRelay(url, { read: relay.read, write: relay.write })) added++;
        }
        done.push(`${added} relays added`);
      }
      setSaid(done.length ? `Restored: ${done.join(', ')}` : 'Nothing was selected');
      setFile(null);
    } catch (err) {
      console.error('Restore failed:', err);
      setError(err instanceof Error ? err.message : 'Could not restore from that file');
    } finally {
      setBusy(null);
    }
  };

  if (!pubkey) {
    return (
      <section className="settings-section">
        <h2>Backup</h2>
        <p className="settings-note">Log in to back up this account.</p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>Backup</h2>
      <p className="settings-note">
        Your profile, who you follow, who you have muted, and your relays — as a file you keep.
        Your key is not in it: a backup that could post as you is a backup worth stealing.
      </p>

      <div className="relay-actions">
        <button className="btn btn-secondary" onClick={handleBackup} disabled={busy !== null}>
          {busy === 'saving' ? 'Reading your lists…' : '⬇ Back up'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => fileInput.current?.click()}
          disabled={busy !== null}
        >
          ⬆ Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={handleChosen}
        />
      </div>

      {file && (
        <div className="backup-restore">
          <p className="settings-note">
            Saved {new Date(file.savedAt).toLocaleString()}
            {file.pubkey !== pubkey && ' — from a different account'}
          </p>

          <label className="backup-choice">
            <input
              type="checkbox"
              checked={restore.profile}
              onChange={e => setRestore(r => ({ ...r, profile: e.target.checked }))}
              disabled={!file.profile}
            />
            Profile{file.profile?.display_name ? ` — ${file.profile.display_name}` : ''}
          </label>
          <label className="backup-choice">
            <input
              type="checkbox"
              checked={restore.follows}
              onChange={e => setRestore(r => ({ ...r, follows: e.target.checked }))}
              disabled={!file.follows?.length}
            />
            {file.follows?.length ?? 0} follows
          </label>
          <label className="backup-choice">
            <input
              type="checkbox"
              checked={restore.muted}
              onChange={e => setRestore(r => ({ ...r, muted: e.target.checked }))}
              disabled={!file.muted?.length}
            />
            {file.muted?.length ?? 0} muted
          </label>
          <label className="backup-choice">
            <input
              type="checkbox"
              checked={restore.relays}
              onChange={e => setRestore(r => ({ ...r, relays: e.target.checked }))}
              disabled={!file.relays?.length}
            />
            {file.relays?.length ?? 0} relays
          </label>

          <p className="settings-note">
            Follows, muted and relays are added to what you have now — nothing is removed.
            The profile is written over the one on your relays.
          </p>

          <div className="relay-actions">
            <button className="btn btn-primary" onClick={handleRestore} disabled={busy !== null}>
              {busy === 'restoring' ? 'Restoring…' : 'Restore'}
            </button>
            <button className="btn btn-secondary" onClick={() => setFile(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {said && <div className="relay-import-result">{said}</div>}
      {error && <div className="login-error">{error}</div>}
    </section>
  );
};

export default BackupSettings;
