import { useState, useEffect } from 'react';
import {
  Routes,
  Route,
  Navigate,
  Link,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams
} from 'react-router-dom';
import { CredentialManager, NostrCrypto } from './nostr/crypto';
import { getRelayPool, DEFAULT_RELAYS } from './nostr/relay';
import { NotificationCore, NotificationStore } from './nostr/notifications';
import { DirectMessageCore, DirectMessageStore } from './nostr/dm';
import { NostrCore, EventCache } from './nostr/core';
import { UserProfile } from './types';
import './index.css';
import LoginPage from './components/LoginPage';
import HomePage from './components/HomePage';
import ProfilePage from './components/ProfilePage';
import SearchPage from './components/SearchPage';
import NotePage from './components/NotePage';
import SettingsPage from './components/SettingsPage';
import NotificationsPage from './components/NotificationsPage';
import MessagesPage from './components/MessagesPage';
import ComposeModal from './components/ComposeModal';
import LivePage from './components/LivePage';
import LiveStreamPage from './components/LiveStreamPage';
import { BellIcon, MessageIcon, SettingsIcon } from './components/Icons';
import { decodeLiveNaddr } from './utils/liveStream';

// URL-safe encode/decode for note ids and pubkeys — bech32 (note1.../npub1...)
// with a raw-hex fallback so malformed or hand-typed links still resolve
function encodeNoteParam(noteId: string): string {
  return NostrCrypto.encodeNote(noteId) || noteId;
}

function decodeNoteParam(param: string | undefined): string | null {
  if (!param) return null;
  if (/^[0-9a-fA-F]{64}$/.test(param)) return param;
  return NostrCrypto.decodeNote(param);
}

function encodeNpubParam(pubkey: string): string {
  return NostrCrypto.npubEncode(pubkey) || pubkey;
}

function decodeNpubParam(param: string | undefined): string | null {
  if (!param) return null;
  if (/^[0-9a-fA-F]{64}$/.test(param)) return param;
  return NostrCrypto.npubDecode(param) || null;
}

interface RouteCallbacks {
  relaysConnected: boolean;
  publicKey: string;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  onNavigateToTopic: (topic: string) => void;
  onNavigateToMessages: (recipient?: string) => void;
  onMarkNotificationsRead: () => void;
  onMarkMessagesRead: () => void;
}

function ProfileRoute({ relaysConnected, publicKey, onNavigateToProfile, onNavigateToNote, onNavigateToTopic, onNavigateToMessages }: RouteCallbacks) {
  const { npub } = useParams();
  const pubkey = decodeNpubParam(npub);

  if (!pubkey) {
    return <div className="profile-page"><div className="error">Invalid profile link</div></div>;
  }

  return (
    <ProfilePage
      pubkey={pubkey}
      isOwnProfile={pubkey === publicKey}
      relaysConnected={relaysConnected}
      onNavigateToProfile={onNavigateToProfile}
      onNavigateToNote={onNavigateToNote}
      onNavigateToTopic={onNavigateToTopic}
      onNavigateToMessages={onNavigateToMessages}
    />
  );
}

function NoteRoute({ relaysConnected, onNavigateToProfile, onNavigateToNote, onNavigateToTopic }: RouteCallbacks) {
  const { noteId: encodedId } = useParams();
  const navigate = useNavigate();
  const noteId = decodeNoteParam(encodedId);

  if (!noteId) {
    return <div className="note-page"><div className="error">Invalid note link</div></div>;
  }

  return (
    <NotePage
      noteId={noteId}
      relaysConnected={relaysConnected}
      onNavigateToProfile={onNavigateToProfile}
      onNavigateToNote={onNavigateToNote}
      onNavigateToTopic={onNavigateToTopic}
      onBack={() => navigate(-1)}
    />
  );
}

function SearchRoute({ relaysConnected, onNavigateToProfile, onNavigateToNote }: RouteCallbacks) {
  const [searchParams] = useSearchParams();
  const topic = searchParams.get('topic');

  return (
    <SearchPage
      // Remount on topic change so a fresh #hashtag navigation always
      // re-runs the search instead of reusing stale component state
      key={topic || ''}
      relaysConnected={relaysConnected}
      onNavigateToProfile={onNavigateToProfile}
      onNavigateToNote={onNavigateToNote}
      initialTopic={topic}
    />
  );
}

function LiveStreamRoute({ onNavigateToProfile }: RouteCallbacks) {
  const { naddr } = useParams();
  const address = naddr ? decodeLiveNaddr(naddr) : null;

  if (!address) {
    return <div className="live-stream-page"><div className="error">Invalid stream link</div></div>;
  }

  return (
    <LiveStreamPage
      kind={address.kind}
      pubkey={address.pubkey}
      identifier={address.identifier}
      onNavigateToProfile={onNavigateToProfile}
    />
  );
}

function MessagesRoute({ relaysConnected, publicKey, onNavigateToProfile, onMarkMessagesRead }: RouteCallbacks) {
  const { npub } = useParams();
  const recipient = decodeNpubParam(npub);

  return (
    <MessagesPage
      pubkey={publicKey}
      relaysConnected={relaysConnected}
      onNavigateToProfile={onNavigateToProfile}
      onMarkRead={onMarkMessagesRead}
      initialRecipient={recipient}
    />
  );
}

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(CredentialManager.isLoggedIn());
  const [publicKey, setPublicKey] = useState(CredentialManager.getPublicKey() || '');
  const [relaysConnected, setRelaysConnected] = useState(false);
  const [ownProfile, setOwnProfile] = useState<UserProfile | null>(
    () => EventCache.getProfile(CredentialManager.getPublicKey() || '') || null
  );
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [showComposeFab, setShowComposeFab] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();

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

  // Background tabs get their relay WebSockets closed/throttled by the
  // browser. Without this, returning to the tab shows a stale "N new
  // posts"/notification badge that needs a couple of polls to actually
  // load, since the underlying sockets are dead until something reconnects
  // them. Reconnect proactively the moment the tab becomes visible again.
  useEffect(() => {
    if (!isLoggedIn) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        getRelayPool().refreshConnectionStatus();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [isLoggedIn]);

  // Load the logged-in user's own profile (for the header avatar) —
  // instant from cache if we have it, refreshed once relays connect
  useEffect(() => {
    if (!relaysConnected || !publicKey) return;
    let cancelled = false;
    NostrCore.fetchUserProfile(publicKey).then(profile => {
      if (!cancelled && profile) setOwnProfile(profile);
    });
    return () => { cancelled = true; };
  }, [relaysConnected, publicKey]);

  // Re-sync from cache on every navigation — cheap and picks up a profile
  // picture you just changed on the Edit Profile form without a reload
  useEffect(() => {
    if (!publicKey) return;
    const cached = EventCache.getProfile(publicKey);
    if (cached) setOwnProfile(cached);
  }, [location.pathname, publicKey]);

  // Poll for the unread notification badge — skipped while the
  // Notifications page itself is open, since it manages the count directly
  useEffect(() => {
    if (!isLoggedIn || !relaysConnected || !publicKey || location.pathname === '/notifications') return;

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
  }, [isLoggedIn, relaysConnected, publicKey, location.pathname]);

  // Poll for the unread message badge — skipped while Messages is open,
  // since it manages last-seen markers directly
  useEffect(() => {
    if (!isLoggedIn || !relaysConnected || !publicKey || location.pathname.startsWith('/messages')) return;

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
  }, [isLoggedIn, relaysConnected, publicKey, location.pathname]);

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
      navigate('/');
    } catch (error) {
      alert('Invalid private key or extension login failed');
    }
  };

  const handleLogout = () => {
    CredentialManager.clear();
    getRelayPool().closeAll();
    // Nothing to clear here: the home feed and recent-searches caches are
    // keyed per-pubkey (see HomePage/SearchPage) and the global feed cache
    // is intentionally shared — it's the same public content for everyone.
    setIsLoggedIn(false);
    setPublicKey('');
    navigate('/');
  };

  const navigateToProfile = (pubkey: string) => {
    navigate(`/p/${encodeNpubParam(pubkey)}`);
  };

  const navigateToNote = (noteId: string) => {
    navigate(`/e/${encodeNoteParam(noteId)}`);
  };

  const navigateToTopic = (topic: string) => {
    navigate(`/search?topic=${encodeURIComponent(topic)}`);
  };

  const navigateToMessages = (recipient?: string) => {
    navigate(recipient ? `/messages/${encodeNpubParam(recipient)}` : '/messages');
  };

  if (!isLoggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const callbacks: RouteCallbacks = {
    relaysConnected,
    publicKey,
    onNavigateToProfile: navigateToProfile,
    onNavigateToNote: navigateToNote,
    onNavigateToTopic: navigateToTopic,
    onNavigateToMessages: navigateToMessages,
    onMarkNotificationsRead: () => setUnreadNotifications(0),
    onMarkMessagesRead: () => setUnreadMessages(0)
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1 className="app-title">⚡ NOSTR</h1>
          <nav className="header-nav">
            <Link to="/" className={`nav-btn ${location.pathname === '/' ? 'active' : ''}`}>
              Home
            </Link>
            <Link to="/live" className={`nav-btn ${location.pathname.startsWith('/live') ? 'active' : ''}`}>
              Live
            </Link>
            <Link to="/search" className={`nav-btn ${location.pathname === '/search' ? 'active' : ''}`}>
              Search
            </Link>
            <Link
              to="/notifications"
              className={`nav-btn nav-btn-icon ${location.pathname === '/notifications' ? 'active' : ''}`}
            >
              <BellIcon /> Notifications
              {unreadNotifications > 0 && (
                <span className="nav-badge">{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>
              )}
            </Link>
            <Link
              to="/messages"
              className={`nav-btn nav-btn-icon ${location.pathname.startsWith('/messages') ? 'active' : ''}`}
            >
              <MessageIcon /> Messages
              {unreadMessages > 0 && (
                <span className="nav-badge">{unreadMessages > 99 ? '99+' : unreadMessages}</span>
              )}
            </Link>
            <Link
              to="/settings/relays"
              className={`nav-btn nav-btn-icon ${location.pathname.startsWith('/settings') ? 'active' : ''}`}
            >
              <SettingsIcon /> Settings
            </Link>
          </nav>
          <div className="header-right">
            <Link
              to={`/p/${encodeNpubParam(publicKey)}`}
              className={`header-avatar-link ${location.pathname.startsWith('/p/') ? 'active' : ''}`}
              title="Your profile"
            >
              {ownProfile?.picture ? (
                <img src={ownProfile.picture} alt="" className="header-avatar" />
              ) : (
                <div className="header-avatar-placeholder">
                  {(ownProfile?.display_name || ownProfile?.name || '?').charAt(0).toUpperCase()}
                </div>
              )}
            </Link>
            <button className="logout-btn" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        <Routes>
          <Route
            path="/"
            element={
              <HomePage
                relaysConnected={relaysConnected}
                onNavigateToProfile={navigateToProfile}
                onNavigateToNote={navigateToNote}
                onNavigateToTopic={navigateToTopic}
              />
            }
          />
          <Route path="/p/:npub" element={<ProfileRoute {...callbacks} />} />
          <Route path="/e/:noteId" element={<NoteRoute {...callbacks} />} />
          <Route path="/search" element={<SearchRoute {...callbacks} />} />
          <Route path="/live" element={<LivePage relaysConnected={relaysConnected} />} />
          <Route path="/live/:naddr" element={<LiveStreamRoute {...callbacks} />} />
          <Route
            path="/notifications"
            element={
              <NotificationsPage
                pubkey={publicKey}
                relaysConnected={relaysConnected}
                onNavigateToProfile={navigateToProfile}
                onNavigateToNote={navigateToNote}
                onMarkRead={callbacks.onMarkNotificationsRead}
              />
            }
          />
          <Route path="/messages" element={<MessagesRoute {...callbacks} />} />
          <Route path="/messages/:npub" element={<MessagesRoute {...callbacks} />} />
          <Route path="/settings" element={<Navigate to="/settings/relays" replace />} />
          <Route path="/settings/relays" element={<SettingsPage />} />
          <Route path="/settings/media" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {location.pathname === '/' && (
        <button
          className="compose-fab"
          onClick={() => setShowComposeFab(true)}
          title="New post"
        >
          +
        </button>
      )}

      {showComposeFab && (
        <ComposeModal
          title="New post"
          onClose={() => setShowComposeFab(false)}
          onPublished={() => setShowComposeFab(false)}
        />
      )}
    </div>
  );
}

export default App;
