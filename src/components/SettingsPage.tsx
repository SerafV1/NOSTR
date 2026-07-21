import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import RelaySettings from './RelaySettings';
import MediaServerSettings from './MediaServerSettings';

const SettingsPage: React.FC = () => {
  const location = useLocation();
  const section = location.pathname.endsWith('/media') ? 'media' : 'relays';

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
        </div>

        {section === 'relays' ? <RelaySettings /> : <MediaServerSettings />}
      </div>
    </div>
  );
};

export default SettingsPage;
