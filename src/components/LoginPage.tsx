import React, { useState, useEffect } from 'react';
import { NostrCrypto, CredentialManager, ExtensionManager } from '../nostr/crypto';
import { publicKeySchemeUri, publicKeyIntentUri, isAndroid } from '../nostr/amber';
import { connectBunker, startNostrConnect } from '../nostr/bunker';

interface LoginPageProps {
  onLogin: (privkey: string) => void;
}

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [amberError, setAmberError] = useState<string | null>(null);
  // A signer that can't hand the answer back through the URL copies it to
  // the clipboard instead — NIP-55 says as much, and Amber does exactly that
  // for web callers. So the paste box opens alongside the request rather
  // than being offered only after something visibly fails.
  const [amberPaste, setAmberPaste] = useState('');

  const [bunkerUri, setBunkerUri] = useState('');
  const [bunkerBusy, setBunkerBusy] = useState(false);

  // Pairing over a relay instead of handing off to the app: nothing here
  // depends on the browser being willing to launch another application, so
  // signing keeps working where NIP-55 gets throttled
  const handleBunkerConnect = async () => {
    setAmberError(null);
    setBunkerBusy(true);
    try {
      const pubkey = await connectBunker(bunkerUri);
      CredentialManager.storePublicKey(pubkey);
      CredentialManager.setBunkerMode(true);
      onLogin('__amber__');
    } catch (error) {
      setAmberError(error instanceof Error ? error.message : 'Could not reach the signer');
    } finally {
      setBunkerBusy(false);
    }
  };

  const [connectUri, setConnectUri] = useState('');
  const [connectWaiting, setConnectWaiting] = useState(false);
  const [connectCopied, setConnectCopied] = useState(false);

  // The direction Amber makes easy: this page publishes an invitation and
  // the signer joins it, so nothing has to be found in Amber's own menus
  const handleStartConnect = () => {
    setAmberError(null);
    setConnectCopied(false);
    const { uri, connected } = startNostrConnect();
    setConnectUri(uri);
    setConnectWaiting(true);
    connected
      .then(pubkey => {
        CredentialManager.storePublicKey(pubkey);
        CredentialManager.setBunkerMode(true);
        onLogin('__amber__');
      })
      .catch(error => {
        setAmberError(error instanceof Error ? error.message : 'The signer never connected');
      })
      .finally(() => setConnectWaiting(false));
  };

  const copyConnectUri = async () => {
    try {
      await navigator.clipboard.writeText(connectUri);
      setConnectCopied(true);
    } catch {
      setAmberError('Could not copy — select the link above and copy it by hand.');
    }
  };

  const pubkeyFromPaste = (value: string): string | null => {
    const trimmed = value.trim().replace(/^nostr:/i, '');
    if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
    if (/^npub1[a-z0-9]+$/i.test(trimmed)) return NostrCrypto.npubDecode(trimmed) || null;
    return null;
  };

  const handleAmberPaste = () => {
    const pubkey = pubkeyFromPaste(amberPaste);
    if (!pubkey) {
      setAmberError('That does not look like a public key. Paste the npub Amber copied.');
      return;
    }
    CredentialManager.storePublicKey(pubkey);
    CredentialManager.setAmberMode(true);
    onLogin('__amber__');
  };

  const pasteFromClipboard = async () => {
    setAmberError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        // Chrome on Android often refuses to read the clipboard rather than
        // reporting it empty, so an empty string proves nothing either way
        setAmberError(
          'Nothing came back from the clipboard. Chrome on Android usually blocks reading it — ' +
          'press and hold the box above and choose Paste instead.'
        );
        return;
      }
      setAmberPaste(text);
    } catch {
      setAmberError(
        'The browser will not let this page read the clipboard. ' +
        'Press and hold the box above and choose Paste instead.'
      );
    }
  };

  const [privkey, setPrivkey] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [mode, setMode] = useState<'login' | 'generate' | 'extension'>('login');
  const [hasExtension, setHasExtension] = useState(false);
  const [isExtensionLoading, setIsExtensionLoading] = useState(false);

  // Check for extension on mount
  useEffect(() => {
    setHasExtension(ExtensionManager.hasExtension());
  }, []);

  const generateNewKey = () => {
    setIsGenerating(true);
    try {
      const newKey = NostrCrypto.generatePrivateKey();
      setPrivkey(newKey);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (privkey.trim()) {
      onLogin(privkey.trim());
    }
  };

  const handleExtensionLogin = async () => {
    if (!ExtensionManager.hasExtension()) {
      alert(
        'No NOSTR extension detected. Make sure nos2x, Alby, or a similar NIP-07 ' +
        'extension is installed and enabled for this browser, then reload the page.'
      );
      return;
    }

    setIsExtensionLoading(true);
    try {
      const pubkey = await ExtensionManager.loginWithExtension();
      if (pubkey) {
        // Pass empty string as privkey, the app will use extension mode
        onLogin('__extension__');
      } else {
        alert('Failed to login with extension. Make sure it\'s installed and enabled.');
      }
    } catch (error) {
      console.error('Extension login failed:', error);
      alert(error instanceof Error ? error.message : 'Extension login failed');
    } finally {
      setIsExtensionLoading(false);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setPrivkey(text.trim());
    } catch (error) {
      alert('Failed to read clipboard');
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <h1>⚡ NOSTR Web App</h1>
          <p>A decentralized social network</p>
        </div>

        <div className="login-content">
          {mode === 'login' ? (
            <>
              <div className="extension-login-section">
                <div className="extension-card">
                  {isAndroid() && (
                    <div className="amber-login">
                      <h3>📱 Login with Amber</h3>
                      <p className="extension-desc">
                        Logging in only needs your <strong>public</strong> key — open Amber,
                        copy your npub, and paste it below. Your private key never leaves
                        the signer app.
                      </p>

                      <div className="amber-paste">
                        <input
                          type="text"
                          className="private-key-input amber-paste-input"
                          placeholder="npub1…"
                          value={amberPaste}
                          onChange={(e) => setAmberPaste(e.target.value)}
                        />
                        <div className="amber-paste-actions">
                          <button type="button" className="btn btn-secondary btn-small" onClick={pasteFromClipboard}>
                            Paste
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-small"
                            onClick={handleAmberPaste}
                            disabled={!amberPaste.trim()}
                          >
                            Use this key
                          </button>
                        </div>
                        <p className="extension-desc">
                          If Paste does nothing, press and hold the box and choose Paste —
                          Chrome on Android usually blocks pages from reading the clipboard.
                        </p>
                      </div>

                      {/* Pairing once, over a relay. Worth its own step
                          because signing afterwards costs no app switch —
                          which is what makes posting from a phone work at
                          all, given how the hand-off gets throttled. */}
                      <div className="amber-paste">
                        <p className="extension-desc">
                          <strong>For posting, not just reading:</strong> in Amber open
                          <em> nsec bunker</em>, copy the <code>bunker://</code> link and paste it
                          here once. Approvals then arrive in Amber without leaving this page.
                        </p>
                        <input
                          type="text"
                          className="private-key-input amber-paste-input"
                          placeholder="bunker://…"
                          value={bunkerUri}
                          onChange={(e) => setBunkerUri(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-primary btn-small"
                          onClick={handleBunkerConnect}
                          disabled={bunkerBusy || !bunkerUri.trim()}
                        >
                          {bunkerBusy ? 'Waiting for Amber…' : 'Pair with Amber'}
                        </button>

                        {/* The same pairing from the other end. Amber's own
                            screen for adding an application is easier to find
                            than its bunker screen, so this is offered first
                            for anyone who can't locate that one. */}
                        <p className="extension-desc">
                          Can't find <em>nsec bunker</em> in Amber? Go the other way:
                        </p>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          onClick={handleStartConnect}
                          disabled={connectWaiting}
                        >
                          {connectWaiting ? 'Waiting for Amber to connect…' : 'Create a link for Amber'}
                        </button>

                        {connectUri && (
                          <div className="connect-uri">
                            <code className="connect-uri-text">{connectUri}</code>
                            <button type="button" className="btn btn-secondary btn-small" onClick={copyConnectUri}>
                              {connectCopied ? 'Copied ✓' : 'Copy link'}
                            </button>
                            <p className="extension-desc">
                              Copy it, open Amber, and add it there as a new application.
                              This page waits and logs you in as soon as Amber connects.
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Kept as a shortcut for browsers that do hand off
                          cleanly, but not the way in: Chrome throttles
                          repeated launches of an external app from a page,
                          so this can work once and then stop. */}
                      <details className="amber-handoff">
                        <summary>Or ask Amber directly</summary>
                        <a className="btn btn-secondary btn-small" href={publicKeySchemeUri()}>
                          Open Amber
                        </a>
                        <a className="btn btn-secondary btn-small" href={publicKeyIntentUri()}>
                          Open Amber (alternative link)
                        </a>
                      </details>

                      {amberError && <div className="login-error">{amberError}</div>}
                      <div className="form-divider">or</div>
                    </div>
                  )}

                  <div className="extension-header">
                    <h3>🔐 Login with Extension</h3>
                    <p className="extension-desc">Use your NOSTR browser extension</p>
                  </div>
                  <p className="extension-info">
                    Supporting extensions: Alby, nos2x, and other NIP-07 compatible wallets
                  </p>
                  <button 
                    type="button"
                    className="btn btn-extension"
                    onClick={handleExtensionLogin}
                    disabled={isExtensionLoading}
                  >
                    {isExtensionLoading ? '⟳ Connecting...' : '🔗 Login with Extension'}
                  </button>
                  {hasExtension && (
                    <div className="extension-badge">
                      ✓ NOSTR extension detected
                    </div>
                  )}
                </div>
              </div>
              <div className="form-divider">or</div>
              <form onSubmit={handleLogin} className="login-form">
                <h2>Manual Login</h2>
                <div className="form-group">
                  <label htmlFor="privkey">Private Key (hex or nsec format)</label>
                  <textarea
                    id="privkey"
                    value={privkey}
                    onChange={(e) => setPrivkey(e.target.value)}
                    placeholder="Enter your private key..."
                    className="private-key-input"
                    rows={4}
                  />
                </div>
                <button type="submit" className="btn btn-primary">
                  Log In
                </button>
                <div className="form-divider">or</div>
                <button 
                  type="button" 
                  className="btn btn-secondary"
                  onClick={handlePaste}
                >
                  Paste from Clipboard
                </button>
                <button 
                  type="button" 
                  className="btn btn-outline"
                  onClick={() => setMode('generate')}
                >
                  Generate New Key
                </button>
              </form>
            </>
          ) : (
            <div className="generate-form">
              <h2>Generate New Key</h2>
              <p className="warning-text">⚠️ Save this key somewhere safe!</p>
              <button 
                className="btn btn-primary"
                onClick={generateNewKey}
                disabled={isGenerating}
              >
                {isGenerating ? 'Generating...' : 'Generate Key'}
              </button>
              {privkey && (
                <div className="key-display">
                  <p className="key-label">Your private key:</p>
                  <div className="key-box">
                    <code>{privkey}</code>
                  </div>
                  <button 
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      navigator.clipboard.writeText(privkey);
                      alert('Copied to clipboard');
                    }}
                  >
                    Copy to Clipboard
                  </button>
                  <button 
                    type="button"
                    className="btn btn-primary"
                    onClick={() => onLogin(privkey)}
                  >
                    Continue
                  </button>
                </div>
              )}
              <button 
                type="button"
                className="btn btn-outline"
                onClick={() => setMode('login')}
              >
                Back to Login
              </button>
            </div>
          )}
        </div>

        <div className="login-info">
          <h3>What is NOSTR?</h3>
          <p>
            NOSTR is an open protocol that enables a decentralized social network. 
            Unlike traditional social media, NOSTR gives you complete control over your identity 
            and data through cryptographic keys.
          </p>
          <h3>Getting Started</h3>
          <ul>
            <li>Login with a browser extension (recommended)</li>
            <li>Generate or import your private key</li>
            <li>Create your profile</li>
            <li>Follow users and publish notes</li>
            <li>Interact with the decentralized network</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
