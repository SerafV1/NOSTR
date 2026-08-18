import React, { useState, useEffect } from 'react';
import { NostrCrypto, CredentialManager, ExtensionManager } from '../nostr/crypto';
import { isAndroid } from '../utils/platform';
import {
  connectBunker,
  startNostrConnect,
  reconnectBunker,
  readPairing,
  forgetPairing,
  EVERYDAY_PERMISSIONS
} from '../nostr/bunker';

interface LoginPageProps {
  onLogin: (privkey: string) => void;
}

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [amberError, setAmberError] = useState<string | null>(null);
  // A signer that can't hand the answer back through the URL copies it to
  // the clipboard instead — NIP-55 says as much, and Amber does exactly that
  // for web callers. So the paste box opens alongside the request rather
  // than being offered only after something visibly fails.

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
      onLogin('__signer__');
    } catch (error) {
      setAmberError(error instanceof Error ? error.message : 'Could not reach the signer');
    } finally {
      setBunkerBusy(false);
    }
  };

  // A signer this browser has been paired with before — logging back in
  // through it needs no new invitation
  const [knownSigner, setKnownSigner] = useState(() => !!readPairing());
  const [reconnecting, setReconnecting] = useState(false);

  const handleReconnect = async () => {
    setAmberError(null);
    setReconnecting(true);
    try {
      const pubkey = await reconnectBunker();
      CredentialManager.storePublicKey(pubkey);
      CredentialManager.setBunkerMode(true);
      onLogin('__signer__');
    } catch (error) {
      setAmberError(
        (error instanceof Error ? error.message : 'The signer did not answer') +
        ' — you can pair again below.'
      );
    } finally {
      setReconnecting(false);
    }
  };

  const [connectUri, setConnectUri] = useState('');
  const [connectWaiting, setConnectWaiting] = useState(false);
  // What the pairing is doing, shown as it happens — otherwise a failure
  // gives nothing to act on but "still waiting"
  const [connectStatus, setConnectStatus] = useState<string | null>(null);
  const [connectCopied, setConnectCopied] = useState(false);

  // The direction Amber makes easy: this page publishes an invitation and
  // the signer joins it, so nothing has to be found in Amber's own menus
  // One tap: make the invitation and open Amber with it. Splitting those in
  // two only made sense while the link had to be carried by hand.
  const handleStartConnect = () => {
    setAmberError(null);
    setConnectCopied(false);
    setConnectStatus('Opening Amber…');
    // The invitation names what it will ask to sign. That isn't the app
    // granting itself anything — it's what Amber shows you to approve or
    // refuse, and with nothing named there is nothing for it to offer.
    const { uri, connected } = startNostrConnect(setConnectStatus, EVERYDAY_PERMISSIONS);
    setConnectUri(uri);
    setConnectWaiting(true);
    window.location.href = uri;
    connected
      .then(pubkey => {
        CredentialManager.storePublicKey(pubkey);
        CredentialManager.setBunkerMode(true);
        onLogin('__signer__');
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
                        Amber keeps your key and approves each action. Pair once and
                        posting works from here, without leaving the page.
                      </p>

                      {/* Pairing once, over a relay. Worth its own step
                          because signing afterwards costs no app switch —
                          which is what makes posting from a phone work at
                          all, given how the hand-off gets throttled. */}
                      <div className="signer-pairing">
                        <p className="extension-desc">
                          <strong>For posting, not just reading:</strong> in Amber open
                          <em> nsec bunker</em>, copy the <code>bunker://</code> link and paste it
                          here once. Approvals then arrive in Amber without leaving this page.
                        </p>
                        <input
                          type="text"
                          className="private-key-input signer-pairing-input"
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
                        {knownSigner && (
                          <div className="known-signer">
                            <p className="extension-desc">
                              This browser is already paired with a signer — just approve the
                              request in Amber, nothing to replace.
                            </p>
                            <button
                              type="button"
                              className="btn btn-primary btn-small"
                              onClick={handleReconnect}
                              disabled={reconnecting}
                            >
                              {reconnecting ? 'Waiting for Amber…' : 'Continue with Amber'}
                            </button>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => { forgetPairing(); setKnownSigner(false); }}
                            >
                              Forget this signer
                            </button>
                          </div>
                        )}

                        <p className="extension-desc">
                          {knownSigner ? 'Or pair a different signer:' : "Can't find "}
                          {!knownSigner && <em>nsec bunker</em>}
                          {!knownSigner && ' in Amber? Go the other way:'}
                        </p>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          onClick={handleStartConnect}
                          disabled={connectWaiting}
                        >
                          {connectWaiting ? 'Waiting for Amber…' : 'Connect Amber'}
                        </button>

                        {connectUri && (
                          <div className="connect-uri">
                            <p className="extension-desc">
                              {connectWaiting
                                ? 'Approve it in Amber — this page logs you in the moment it connects, with nothing to bring back.'
                                : 'Amber connected.'}
                            </p>
                            {connectStatus && <p className="connect-status">{connectStatus}</p>}
                            {/* Amber registers this scheme, so a second try
                                costs one tap. Only shown after the first
                                attempt, so the ordinary path stays a single
                                click. */}
                            <a className="btn btn-secondary btn-small" href={connectUri}>
                              Open Amber again
                            </a>
                            <details>
                              <summary className="connect-uri-summary">Amber didn't open? Copy the link</summary>
                              <code className="connect-uri-text">{connectUri}</code>
                              <button type="button" className="btn btn-secondary btn-small" onClick={copyConnectUri}>
                                {connectCopied ? 'Copied ✓' : 'Copy link'}
                              </button>
                            </details>
                          </div>
                        )}
                      </div>

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
