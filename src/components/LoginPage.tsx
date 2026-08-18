import React, { useState, useEffect } from 'react';
import { NostrCrypto, CredentialManager, ExtensionManager } from '../nostr/crypto';
import { publicKeySchemeUri, publicKeyIntentUri, isAndroid } from '../nostr/amber';

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
    try {
      const text = await navigator.clipboard.readText();
      setAmberPaste(text);
    } catch {
      setAmberError('The browser would not share the clipboard — paste into the box by hand.');
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
                        Your key stays in the signer app. Tap to approve, then come back here.
                      </p>

                      {/* Two shapes of the same request. Which one a phone
                          honours depends on the browser and the signer build,
                          and nothing in here can tell — so both are offered
                          instead of one being guessed at. */}
                      <a className="btn btn-extension" href={publicKeySchemeUri()}>
                        🔗 Open Amber
                      </a>
                      <a className="btn btn-secondary btn-small" href={publicKeyIntentUri()}>
                        Open Amber (alternative link)
                      </a>

                      {/* Always here, not hidden behind a failure: a signer
                          that can't answer through the URL copies the key to
                          the clipboard instead, and then this is the only way
                          in. NIP-55 says as much. */}
                      <div className="amber-paste">
                        <p className="extension-desc">
                          Back here and still logged out? Amber copied your public key —
                          paste it in.
                        </p>
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
