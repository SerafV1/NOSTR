import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import RelaySettings from './RelaySettings';
import MediaServerSettings from './MediaServerSettings';
import MutedSettings from './MutedSettings';

interface SettingsPageProps {
  relaysConnected: boolean;
}

const SettingsPage: React.FC<SettingsPageProps> = ({ relaysConnected }) => {
  const location = useLocation();
  const section = location.pathname.endsWith('/media')
    ? 'media'
    : location.pathname.endsWith('/muted') ? 'muted' : 'relays';

  return (
    <div className="settings-page">
      <div className="settings-container">
        <h1>Settings</h1>

        <div className="settings-tabs">
          <Link
            to="/settings/relays"
            className={`settings-tab ${section === 'relays' ? 'active' : ''}`}
          >
            Relays
          </Link>
          <Link
            to="/settings/media"
            className={`settings-tab ${section === 'media' ? 'active' : ''}`}
          >
            Media Servers
          </Link>
          <Link
            to="/settings/muted"
            className={`settings-tab ${section === 'muted' ? 'active' : ''}`}
          >
            Muted
          </Link>
        </div>

        {section === 'relays' && <RelaySettings />}
        {section === 'media' && <MediaServerSettings />}
        {section === 'muted' && <MutedSettings relaysConnected={relaysConnected} />}
      </div>
    </div>
  );
};

export default SettingsPage;
