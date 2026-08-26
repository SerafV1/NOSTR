import React, { useRef, useState } from 'react';
import { NostrCore, EventCache } from '../nostr/core';
import { CredentialManager } from '../nostr/crypto';
import { getRelayPool } from '../nostr/relay';
import { UserProfile } from '../types';

type Part = 'profile' | 'follows' | 'muted' | 'relays';

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
  // Which row's Import is waiting for a file — null means the whole account
  const awaiting = useRef<Part | null>(null);

  const pubkey = CredentialManager.getPublicKey();

  /**
   * One file, holding whichever parts were asked for. A backup of everything
   * and a backup of one list are the same shape — the parts not asked for
   * are simply absent — so the same import reads either, and a file with only
   * relays in it cannot touch a follow list by accident.
   */
  const saveParts = async (parts: Part[], name: string) => {
    if (!pubkey) return;
    setBusy('saving');
    setError(null);
    setSaid(null);
    try {
      const wants = new Set(parts);
      const peopleIn = (list: { tags: string[][] } | null) =>
        (list?.tags || []).filter(t => t[0] === 'p' && t[1]).map(t => t[1]);

      const [profile, follows, muted] = await Promise.all([
        wants.has('profile')
          ? NostrCore.fetchUserProfile(pubkey).catch(() => EventCache.getProfile(pubkey) || null)
          : null,
        wants.has('follows') ? NostrCore.readFollowList() : null,
        wants.has('muted') ? NostrCore.readMuteList() : null
      ]);

      const backup: AccountBackup = {
        app: 'razr',
        kind: 'account',
        savedAt: new Date().toISOString(),
        pubkey,
        // The key itself is deliberately not here
        ...(wants.has('profile') && profile ? { profile: { ...profile, pubkey: undefined } } : {}),
        ...(wants.has('follows') ? { follows: peopleIn(follows) } : {}),
        ...(wants.has('muted') ? { muted: peopleIn(muted) } : {}),
        ...(wants.has('relays')
          ? {
              relays: getRelayPool().getRelayConfigs().map(config => ({
                url: config.url,
                read: config.read !== false,
                write: config.write !== false
              }))
            }
          : {})
      };

      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `razr-${name}-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      const held = [
        backup.profile ? 'profile' : null,
        backup.follows ? `${backup.follows.length} follows` : null,
        backup.muted ? `${backup.muted.length} muted` : null,
        backup.relays ? `${backup.relays.length} relays` : null
      ].filter(Boolean);
      setSaid(`Saved: ${held.join(', ')}`);
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

    // One list at a time goes straight back; a whole account is offered as a
    // set of choices first, since it can carry four of them at once
    const part = awaiting.current;
    awaiting.current = null;
    if (part) {
      await importPart(part, chosen);
      return;
    }

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

  /** Put one list back, and say what that did */
  const restorePart = async (part: Part, data: AccountBackup): Promise<string> => {
    if (part === 'profile') {
      if (!data.profile) throw new Error('That file holds no profile');
      await NostrCore.publishProfile(data.profile);
      return 'profile restored';
    }
    if (part === 'follows') {
      if (!data.follows?.length) throw new Error('That file holds no follows');
      return `${await NostrCore.restoreFollows(data.follows)} follows added`;
    }
    if (part === 'muted') {
      if (!data.muted?.length) throw new Error('That file holds nobody muted');
      return `${await NostrCore.restoreMutes(data.muted)} muted added`;
    }
    if (!data.relays?.length) throw new Error('That file holds no relays');
    const pool = getRelayPool();
    const already = new Set(pool.getRelayConfigs().map(c => c.url.replace(/\/$/, '')));
    let added = 0;
    for (const relay of data.relays) {
      const url = relay.url.replace(/\/$/, '');
      if (already.has(url)) pool.updateRelayCapabilities(url, relay.read, relay.write);
      else if (await pool.addRelay(url, { read: relay.read, write: relay.write })) added++;
    }
    return `${added} relays added`;
  };

  /**
   * Importing one list: the file is read and that part of it put back at
   * once. Nothing else in the file is touched, so a whole-account backup can
   * be used to restore only the relays from it.
   */
  const importPart = async (part: Part, chosen: File) => {
    setBusy('restoring');
    setError(null);
    setSaid(null);
    try {
      const parsed = JSON.parse(await chosen.text()) as AccountBackup;
      if (parsed.kind !== 'account') throw new Error('That file is not a backup from here');
      setSaid(await restorePart(part, parsed));
    } catch (err) {
      console.error('Import failed:', err);
      setError(err instanceof Error ? err.message : 'That file could not be read');
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    if (!file) return;
    setBusy('restoring');
    setError(null);
    setSaid(null);
    const done: string[] = [];
    try {
      const wanted: Part[] = [
        restore.profile && file.profile ? 'profile' : null,
        restore.follows && file.follows?.length ? 'follows' : null,
        restore.muted && file.muted?.length ? 'muted' : null,
        restore.relays && file.relays?.length ? 'relays' : null
      ].filter(Boolean) as Part[];

      for (const part of wanted) done.push(await restorePart(part, file));
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

      {/* Each list on its own, for carrying one somewhere without the rest.
          A row's Import takes that part out of whatever file it is given —
          including a whole-account backup — and leaves the rest alone. */}
      <div className="backup-rows">
        {([
          ['profile', 'Profile'],
          ['follows', 'Follows'],
          ['muted', 'Muted'],
          ['relays', 'Relays']
        ] as [Part, string][]).map(([part, label]) => (
          <div className="backup-row" key={part}>
            <span className="backup-row-name">{label}</span>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => saveParts([part], part)}
              disabled={busy !== null}
            >
              ⬇ Export
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => { awaiting.current = part; fileInput.current?.click(); }}
              disabled={busy !== null}
            >
              ⬆ Import
            </button>
          </div>
        ))}
      </div>

      <div className="backup-rows backup-rows-all">
        <div className="backup-row">
          <span className="backup-row-name">Everything</span>
          <button
            className="btn btn-secondary btn-small"
            onClick={() => saveParts(['profile', 'follows', 'muted', 'relays'], 'account')}
            disabled={busy !== null}
          >
            {busy === 'saving' ? 'Reading…' : '⬇ Export'}
          </button>
          <button
            className="btn btn-secondary btn-small"
            onClick={() => { awaiting.current = null; fileInput.current?.click(); }}
            disabled={busy !== null}
          >
            ⬆ Import
          </button>
        </div>
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
            {/* A file saved one part at a time holds only that part */}
            {!file.profile && !file.follows && !file.muted ? ' — relays only' : ''}
          </p>

          <label className="backup-choice">
            <input
              type="checkbox"
              checked={restore.profile && !!file.profile}
              onChange={e => setRestore(r => ({ ...r, profile: e.target.checked }))}
              disabled={!file.profile}
            />
            Profile{file.profile?.display_name ? ` — ${file.profile.display_name}` : ''}
          </label>
          <label className="backup-choice">
            <input
              type="checkbox"
              checked={restore.follows && !!file.follows?.length}
              onChange={e => setRestore(r => ({ ...r, follows: e.target.checked }))}
              disabled={!file.follows?.length}
            />
            {file.follows?.length ?? 0} follows
          </label>
          <label className="backup-choice">
            <input
              type="checkbox"
              checked={restore.muted && !!file.muted?.length}
              onChange={e => setRestore(r => ({ ...r, muted: e.target.checked }))}
              disabled={!file.muted?.length}
            />
            {file.muted?.length ?? 0} muted
          </label>
          <label className="backup-choice">
            <input
              type="checkbox"
              checked={restore.relays && !!file.relays?.length}
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
