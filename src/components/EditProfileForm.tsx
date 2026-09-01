import React, { useEffect, useState } from 'react';
import { UserProfile } from '../types';
import { NostrCore } from '../nostr/core';
import { cleanAddress, isPayable, fromPaytoEvent } from '../utils/paymentTargets';

interface EditProfileFormProps {
  profile: UserProfile;
  onSave: (profile: Partial<UserProfile>) => void;
}

const EditProfileForm: React.FC<EditProfileFormProps> = ({ profile, onSave }) => {
  // What is already published for this account in its own event (NIP-A3),
  // which is where the addresses belong and where other clients read them
  const [paytoLoaded, setPaytoLoaded] = useState(false);
  const [formData, setFormData] = useState({
    name: profile.name || '',
    display_name: profile.display_name || '',
    about: profile.about || '',
    picture: profile.picture || '',
    website: profile.website || '',
    banner: profile.banner || '',
    nip05: profile.nip05 || '',
    lud16: profile.lud16 || '',
    // Not lightning: an address people can send to without a channel open.
    // No NIP names these — `btc` and `xmr` are the spellings that exist in
    // the wild, so those are what this writes.
    btc: cleanAddress(profile.btc),
    xmr: cleanAddress(profile.xmr)
  });
  const [saving, setSaving] = useState(false);
  /** What went wrong publishing the addresses, in the page rather than the console */
  const [targetsError, setTargetsError] = useState<string | null>(null);

  // The event is the source of truth; the kind-0 fields are only what this
  // client wrote before the kind existed
  useEffect(() => {
    let cancelled = false;
    const owner = profile.pubkey;
    if (!owner) return;
    NostrCore.fetchPaymentTargets(owner)
      .then(event => {
        if (cancelled) return;
        const published = fromPaytoEvent(event);
        const bitcoin = published.find(target => target.label === 'Bitcoin');
        const monero = published.find(target => target.label === 'Monero');
        setFormData(current => ({
          ...current,
          btc: bitcoin?.address || current.btc,
          xmr: monero?.address || current.xmr
        }));
        setPaytoLoaded(true);
      })
      .catch(() => { if (!cancelled) setPaytoLoaded(true); });
    return () => { cancelled = true; };
  }, [profile.pubkey]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  // Checked before it is published, not after somebody has sent to it
  const badBtc = formData.btc.trim() !== '' && !isPayable('bitcoin', formData.btc);
  const badXmr = formData.xmr.trim() !== '' && !isPayable('monero', formData.xmr);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (badBtc || badXmr) return;
    setSaving(true);

    try {
      // Kind 0 replaces the whole metadata event, so merge with the existing
      // profile to avoid wiping fields the form doesn't cover or left empty
      const { pubkey: _pubkey, ...existingFields } = profile;
      const tidied = {
        ...formData,
        btc: cleanAddress(formData.btc),
        xmr: cleanAddress(formData.xmr)
      };
      const updatedProfile = Object.entries({ ...existingFields, ...tidied })
        .filter(([_key, value]) => value !== '' && value !== undefined && value !== null)
        .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {} as Partial<UserProfile>);

      const published = await NostrCore.publishProfile(updatedProfile);

      // And the event other clients actually read. Published even when the
      // addresses are empty, so removing one here removes it there. It is
      // signed separately from the profile, so with an extension or a signer
      // app it asks a second time — and if that second answer never comes,
      // the page has to say so rather than look saved.
      setTargetsError(null);
      if (paytoLoaded || tidied.btc || tidied.xmr) {
        try {
          await NostrCore.publishPaymentTargets([
            ...(tidied.btc ? [{ type: 'bitcoin', address: tidied.btc }] : []),
            ...(tidied.xmr ? [{ type: 'monero', address: tidied.xmr }] : [])
          ]);
        } catch (failure) {
          setTargetsError(
            `The profile was saved, but the addresses were not published: ${
              failure instanceof Error ? failure.message : 'unknown reason'
            }. Other clients read them from that event, so try Save again.`
          );
          setSaving(false);
          return;
        }
      }

      if (published) {
        onSave(updatedProfile);
      }
    } catch (error) {
      console.error('Failed to update profile:', error);
      alert('Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="edit-profile-form" onSubmit={handleSubmit}>
      <h3>Edit Profile</h3>

      <div className="form-group">
        <label htmlFor="name">Name</label>
        <input
          type="text"
          id="name"
          name="name"
          value={formData.name}
          onChange={handleChange}
          placeholder="Your name"
        />
      </div>

      <div className="form-group">
        <label htmlFor="display_name">Display Name</label>
        <input
          type="text"
          id="display_name"
          name="display_name"
          value={formData.display_name}
          onChange={handleChange}
          placeholder="Display name"
        />
      </div>

      <div className="form-group">
        <label htmlFor="about">Bio</label>
        <textarea
          id="about"
          name="about"
          value={formData.about}
          onChange={handleChange}
          placeholder="Tell us about yourself"
          rows={3}
        />
      </div>

      <div className="form-group">
        <label htmlFor="picture">Profile Picture URL</label>
        <input
          type="url"
          id="picture"
          name="picture"
          value={formData.picture}
          onChange={handleChange}
          placeholder="https://example.com/avatar.jpg"
        />
      </div>

      <div className="form-group">
        <label htmlFor="banner">Banner URL</label>
        <input
          type="url"
          id="banner"
          name="banner"
          value={formData.banner}
          onChange={handleChange}
          placeholder="https://example.com/banner.jpg"
        />
      </div>

      <div className="form-group">
        <label htmlFor="website">Website</label>
        <input
          type="url"
          id="website"
          name="website"
          value={formData.website}
          onChange={handleChange}
          placeholder="https://example.com"
        />
      </div>

      <div className="form-group">
        <label htmlFor="nip05">NIP-05 Identifier</label>
        <input
          type="text"
          id="nip05"
          name="nip05"
          value={formData.nip05}
          onChange={handleChange}
          placeholder="user@example.com"
        />
      </div>

      <div className="form-group">
        <label htmlFor="lud16">Lightning Address (LUD-16)</label>
        <input
          type="text"
          id="lud16"
          name="lud16"
          value={formData.lud16}
          onChange={handleChange}
          placeholder="user@lightning.address"
        />
      </div>

      <div className="form-group">
        <label htmlFor="btc">Bitcoin address (on-chain)</label>
        <input
          type="text"
          id="btc"
          name="btc"
          value={formData.btc}
          onChange={handleChange}
          placeholder="bc1…"
          spellCheck={false}
        />
        {badBtc && <span className="form-error">That is not a bitcoin address</span>}
      </div>

      <div className="form-group">
        <label htmlFor="xmr">Monero address</label>
        <input
          type="text"
          id="xmr"
          name="xmr"
          value={formData.xmr}
          onChange={handleChange}
          placeholder="4… or 8…"
          spellCheck={false}
        />
        {badXmr && <span className="form-error">That is not a monero address</span>}
      </div>

      {/* Measured, not assumed: Amethyst's profile model (quartz
          UserMetadata) parses name, picture, banner, website, about, nip05,
          lud06, lud16 and a few others — and no on-chain field at all. So an
          address written here is read by this client and by anyone who
          copies the convention, and by nobody else. In the bio it is read
          everywhere, because everyone shows a bio. */}
      {targetsError && <div className="error-message">{targetsError}</div>}

      <p className="settings-hint">
        Published as a payment-targets event of its own (NIP-A3, kind 10133), which is
        what Amethyst reads and writes — so an address set here shows up there too.
      </p>

      <button 
        type="submit" 
        className="btn btn-primary"
        disabled={saving || badBtc || badXmr}
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </form>
  );
};

export default EditProfileForm;
