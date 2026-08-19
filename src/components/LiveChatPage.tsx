import React from 'react';
import LiveChatPanel from './LiveChatPanel';
import { liveEventAddress } from '../utils/liveStream';
import { CredentialManager } from '../nostr/crypto';

interface LiveChatPageProps {
  kind: number;
  relaysConnected: boolean;
  pubkey: string;
  identifier: string;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

/**
 * The stream's chat on its own, for a window you keep beside the video —
 * a second screen, half a desktop, or an OBS browser source. Nothing else is
 * on the page, so it stays readable at the width a chat window actually gets.
 *
 * `?transparent=1` drops the background, for laying the chat over the video
 * in a stream overlay.
 */
const LiveChatPage: React.FC<LiveChatPageProps> = ({
  kind,
  pubkey,
  identifier,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic
}) => {
  const transparent = new URLSearchParams(window.location.search).get('transparent') === '1';
  // In an overlay nobody can type, and the box would only take up room
  const readOnly = !CredentialManager.isLoggedIn();

  return (
  <div className={`live-chat-page ${transparent ? 'transparent' : ''}`}>
    <LiveChatPanel
      address={liveEventAddress(kind, pubkey, identifier)}
      relaysConnected={relaysConnected}
      hideComposer={readOnly}
      onNavigateToProfile={onNavigateToProfile}
      onNavigateToNote={onNavigateToNote}
      onNavigateToTopic={onNavigateToTopic}
    />
  </div>
  );
};

export default LiveChatPage;
