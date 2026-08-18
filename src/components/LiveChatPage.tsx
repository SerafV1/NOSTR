import React from 'react';
import LiveChatPanel from './LiveChatPanel';
import { liveEventAddress } from '../utils/liveStream';

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
 * a second screen, or half a desktop. Nothing else is on the page, so it
 * stays readable at the width a chat window actually gets.
 */
const LiveChatPage: React.FC<LiveChatPageProps> = ({
  kind,
  pubkey,
  identifier,
  relaysConnected,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic
}) => (
  <div className="live-chat-page">
    <LiveChatPanel
      address={liveEventAddress(kind, pubkey, identifier)}
      relaysConnected={relaysConnected}
      onNavigateToProfile={onNavigateToProfile}
      onNavigateToNote={onNavigateToNote}
      onNavigateToTopic={onNavigateToTopic}
    />
  </div>
);

export default LiveChatPage;
