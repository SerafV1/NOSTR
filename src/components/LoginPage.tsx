import React, { useState, useEffect } from 'react';
import { NostrCrypto, ExtensionManager } from '../nostr/crypto';

interface LoginPageProps {
  onLogin: (privkey: string) => void;
}

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
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
      setMode('login');
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
      alert('Extension login failed');
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
