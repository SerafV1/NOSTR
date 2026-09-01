import React, { useState } from 'react';
import { UserProfile } from '../types';
import { NostrCore } from '../nostr/core';
import { cleanAddress, isPayable } from '../utils/paymentTargets';

interface EditProfileFormProps {
  profile: UserProfile;
  onSave: (profile: Partial<UserProfile>) => void;
}

const EditProfileForm: React.FC<EditProfileFormProps> = ({ profile, onSave }) => {
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
