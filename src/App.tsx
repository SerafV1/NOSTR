import { useState, useEffect } from 'react';
import { CredentialManager, NostrCrypto } from './nostr/crypto';
import { getRelayPool, DEFAULT_RELAYS } from './nostr/relay';
import { NotificationCore, NotificationStore } from './nostr/notifications';
import { DirectMessageCore, DirectMessageStore } from './nostr/dm';
import './index.css';
import LoginPage from './components/LoginPage';
import HomePage from './components/HomePage';
import ProfilePage from './components/ProfilePage';
import SearchPage from './components/SearchPage';
import NotePage from './components/NotePage';
import SettingsPage from './components/SettingsPage';
import NotificationsPage from './components/NotificationsPage';
import MessagesPage from './components/MessagesPage';

type Page = 'home' | 'profile' | 'search' | 'note' | 'settings' | 'notifications' | 'messages';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(CredentialManager.isLoggedIn());
  const [publicKey, setPublicKey] = useState(CredentialManager.getPublicKey() || '');
  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [searchTopic, setSearchTopic] = useState<string | null>(null);
  // Bumped on every topic navigation so SearchPage re-runs the search even
  // when the same topic is clicked twice in a row
  const [topicNavKey, setTopicNavKey] = useState(0);
  // Where the user came from when opening a note, so Back can return there
  const [noteReturnPage, setNoteReturnPage] = useState<Page>('home');
  const [relaysConnected, setRelaysConnected] = useState(false);
  const [relayInfos, setRelayInfos] = useState<{ url: string; connected: boolean; paid: boolean }[]>([]);
  const [showRelayPanel, setShowRelayPanel] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [messagesRecipient, setMessagesRecipient] = useState<string | null>(null);

  // Initialize relays on mount
  useEffect(() => {
    const initializeRelays = async () => {
      const relayPool = getRelayPool();
      let connectedCount = 0;

      // Get excluded and saved relays (use unfiltered for initialization)
      const excludedRelays = relayPool.getExcludedRelays();
      const savedConfigs = relayPool.getAllSavedRelayConfigs();
      const savedUrls = new Set(savedConfigs.map(c => c.url));
      
      // Combine DEFAULT_RELAYS with saved relays, excluding any that user removed
      const allRelayUrls = Array.from(
        new Set([
          ...DEFAULT_RELAYS.filter(url => !excludedRelays.has(url)),
          ...savedUrls
        ])
      );

      console.log('[App] Initializing relays with:', allRelayUrls);
      console.log('[App] Excluded relays:', Array.from(excludedRelays));

      // Set a timeout - mark as connected after 5 seconds even if not all relays ready
      const timeout = setTimeout(() => {
        console.warn('[App] Relay initialization timeout');
        if (connectedCount === 0) {
          console.warn('[App] No relays connected, proceeding with fallback');
          setRelaysConnected(true);
        }
      }, 5000);

      // Connect to all relays in parallel — serial connects made startup
      // take up to 10s per slow relay
      const results = await Promise.all(
        allRelayUrls.map(relay => relayPool.addRelay(relay))
      );
      connectedCount = results.filter(Boolean).length;

      clearTimeout(timeout);
      
      // Clean up any stale relay configs that don't have active relays
      relayPool.cleanupStaleConfigs();
      
      setRelaysConnected(true);
      
      const status = relayPool.getStatus();
      const actualConnected = Array.from(status.values()).filter(v => v).length;
      console.log(`[App] Relay initialization complete: ${actualConnected}/${allRelayUrls.length} connected`);
    };

    if (isLoggedIn) {
      console.log('[App] User logged in, initializing relays');
      initializeRelays();
    }

    return () => {
      // Cleanup on unmount
      // getRelayPool().closeAll();
    };
  }, [isLoggedIn]);

  // Keep per-relay status (connected / paid) fresh for the header panel
  useEffect(() => {
    if (!isLoggedIn) return;

    const refreshRelayInfos = () => {
      const relayPool = getRelayPool();
      const status = relayPool.getStatus();
      const capabilities = relayPool.getAllCapabilities();
      setRelayInfos(relayPool.getRelays().map(url => ({
        url,
        connected: status.get(url) || false,
        paid: capabilities.get(url)?.paid ?? false
      })));
    };

    refreshRelayInfos();
    const interval = setInterval(refreshRelayInfos, 5000);
    return () => clearInterval(interval);
  }, [isLoggedIn, relaysConnected]);

  // Poll for the unread notification badge — skipped while the
  // Notifications page itself is open, since it manages the count directly
  useEffect(() => {
    if (!isLoggedIn || !relaysConnected || !publicKey || currentPage === 'notifications') return;

    const refreshUnread = async () => {
      try {
        const notifications = await NotificationCore.fetchNotifications(publicKey, 50);
        setUnreadNotifications(NotificationStore.countUnread(publicKey, notifications));
      } catch (error) {
        console.error('Failed to refresh notification badge:', error);
      }
    };

    refreshUnread();
    const interval = setInterval(refreshUnread, 30000);
    return () => clearInterval(interval);
  }, [isLoggedIn, relaysConnected, publicKey, currentPage]);

  // Poll for the unread message badge — skipped while Messages is open,
  // since it manages last-seen markers directly
  useEffect(() => {
    if (!isLoggedIn || !relaysConnected || !publicKey || currentPage === 'messages') return;

    const refreshUnread = async () => {
      try {
        const messages = await DirectMessageCore.fetchMessages(publicKey);
        const conversations = DirectMessageCore.groupConversations(messages);
        setUnreadMessages(DirectMessageStore.countUnread(publicKey, conversations));
      } catch (error) {
        console.error('Failed to refresh message badge:', error);
      }
    };

    refreshUnread();
    const interval = setInterval(refreshUnread, 30000);
    return () => clearInterval(interval);
  }, [isLoggedIn, relaysConnected, publicKey, currentPage]);

  const handleLogin = (privkey: string) => {
    try {
      let pubkey: string;

      if (privkey === '__extension__') {
        // Extension mode - get public key from localStorage (set by ExtensionManager)
        pubkey = CredentialManager.getPublicKey() || '';
        if (!pubkey) {
          alert('Extension login failed: could not retrieve public key');
          return;
        }
      } else {
        // Manual mode - get public key from private key
        pubkey = NostrCrypto.getPublicKey(privkey);
        CredentialManager.storePrivateKey(privkey);
        CredentialManager.storePublicKey(pubkey);
      }

      setPublicKey(pubkey);
      setIsLoggedIn(true);
    } catch (error) {
      alert('Invalid private key or extension login failed');
    }
  };

  const handleLogout = () => {
    CredentialManager.clear();
    getRelayPool().closeAll();
    setIsLoggedIn(false);
    setPublicKey('');
    setCurrentPage('home');
  };

  const navigateToProfile = (pubkey: string) => {
    setSelectedProfile(pubkey);
    setCurrentPage('profile');
  };

  const navigateToSearch = () => {
    setCurrentPage('search');
  };

  const navigateToNote = (noteId: string) => {
    setNoteReturnPage(prev => (currentPage === 'note' ? prev : currentPage));
    setSelectedNoteId(noteId);
    setCurrentPage('note');
  };

  const navigateToTopic = (topic: string) => {
    setSearchTopic(topic);
    setTopicNavKey(key => key + 1);
    setCurrentPage('search');
  };

  const navigateToMessages = (recipient?: string) => {
    setMessagesRecipient(recipient || null);
    setCurrentPage('messages');
  };

  const navigateBackFromNote = () => {
    setCurrentPage(noteReturnPage);
    setSelectedNoteId(null);
  };

  if (!isLoggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1 className="app-title">⚡ NOSTR</h1>
          <nav className="header-nav">
            <button 
              className={`nav-btn ${currentPage === 'home' ? 'active' : ''}`}
              onClick={() => setCurrentPage('home')}
            >
              Home
            </button>
            <button 
              className={`nav-btn ${currentPage === 'profile' ? 'active' : ''}`}
              onClick={() => {
                setCurrentPage('profile');
                setSelectedProfile(publicKey);
              }}
            >
              Profile
            </button>
            <button
              className="nav-btn"
              onClick={navigateToSearch}
            >
              Search
            </button>
            <button
              className={`nav-btn ${currentPage === 'notifications' ? 'active' : ''}`}
              onClick={() => setCurrentPage('notifications')}
            >
              🔔 Notifications
              {unreadNotifications > 0 && (
                <span className="nav-badge">{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>
              )}
            </button>
            <button
              className={`nav-btn ${currentPage === 'messages' ? 'active' : ''}`}
              onClick={() => navigateToMessages()}
            >
              ✉️ Messages
              {unreadMessages > 0 && (
                <span className="nav-badge">{unreadMessages > 99 ? '99+' : unreadMessages}</span>
              )}
            </button>
            <button
              className={`nav-btn ${currentPage === 'settings' ? 'active' : ''}`}
              onClick={() => setCurrentPage('settings')}
            >
              ⚙️ Settings
            </button>
          </nav>
          <div className="header-right">
            <div className="relay-status-wrapper">
              <button
                className="relay-status relay-status-toggle"
                onClick={() => setShowRelayPanel(!showRelayPanel)}
                title="Show relay details"
              >
                <span className={`status-dot ${relayInfos.some(r => r.connected) ? 'connected' : 'disconnected'}`}></span>
                <span>
                  {relayInfos.length > 0
                    ? `${relayInfos.filter(r => r.connected).length}/${relayInfos.length} relays`
                    : relaysConnected ? 'Connected' : 'Offline'}
                </span>
              </button>
              {showRelayPanel && (
                <div className="relay-status-panel">
                  {relayInfos.length === 0 ? (
                    <div className="relay-status-row">No relays configured</div>
                  ) : (
                    relayInfos.map(relay => (
                      <div key={relay.url} className="relay-status-row">
                        <span className={`status-dot ${relay.connected ? 'connected' : 'disconnected'}`}></span>
                        <span className="relay-status-url">{relay.url.replace(/^wss?:\/\//, '')}</span>
                        <span className={`relay-fee-badge ${relay.paid ? 'paid' : 'free'}`}>
                          {relay.paid ? '💳 Paid' : 'Free'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            <button className="logout-btn" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        {currentPage === 'home' && (
          <HomePage
            relaysConnected={relaysConnected}
            onNavigateToProfile={navigateToProfile}
            onNavigateToNote={navigateToNote}
            onNavigateToTopic={navigateToTopic}
          />
        )}
        {currentPage === 'profile' && selectedProfile && (
          <ProfilePage
            pubkey={selectedProfile}
            isOwnProfile={selectedProfile === publicKey}
            relaysConnected={relaysConnected}
            onNavigateToProfile={navigateToProfile}
            onNavigateToNote={navigateToNote}
            onNavigateToTopic={navigateToTopic}
            onNavigateToMessages={navigateToMessages}
          />
        )}
        {currentPage === 'search' && (
          <SearchPage
            onNavigateToProfile={navigateToProfile}
            onNavigateToNote={navigateToNote}
            initialTopic={searchTopic}
            topicNavKey={topicNavKey}
          />
        )}
        {currentPage === 'note' && selectedNoteId && (
          <NotePage
            noteId={selectedNoteId}
            onNavigateToProfile={navigateToProfile}
            onNavigateToNote={navigateToNote}
            onNavigateToTopic={navigateToTopic}
            onBack={navigateBackFromNote}
          />
        )}
        {currentPage === 'notifications' && (
          <NotificationsPage
            pubkey={publicKey}
            relaysConnected={relaysConnected}
            onNavigateToProfile={navigateToProfile}
            onNavigateToNote={navigateToNote}
            onMarkRead={() => setUnreadNotifications(0)}
          />
        )}
        {currentPage === 'messages' && (
          <MessagesPage
            pubkey={publicKey}
            relaysConnected={relaysConnected}
            onNavigateToProfile={navigateToProfile}
            onMarkRead={() => setUnreadMessages(0)}
            initialRecipient={messagesRecipient}
          />
        )}
        {currentPage === 'settings' && (
          <SettingsPage />
        )}
      </main>
    </div>
  );
}

export default App;
