import React, { useState } from 'react';
import EmojiPicker from './EmojiPicker';
import { useAnchoredPopup } from '../hooks/useAnchoredPopup';

export interface ReactionTally {
  emoji: string;
  count: number;
  /** Already reacted with this one — reacting twice says nothing new */
  mine: boolean;
}

interface LiveChatReactionsProps {
  tallies: ReactionTally[];
  canReact: boolean;
  onReact: (emoji: string) => void;
}

/**
 * Reactions under one chat message: the ones already there, and a picker to
 * add another. Its own component because each message needs its own anchored
 * picker, and hooks cannot live inside the loop that renders the messages.
 */
const LiveChatReactions: React.FC<LiveChatReactionsProps> = ({ tallies, canReact, onReact }) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useAnchoredPopup(pickerOpen, () => setPickerOpen(false));

  const react = (emoji: string) => {
    setPickerOpen(false);
    onReact(emoji);
  };

  return (
    <span className="live-chat-reactions">
      {tallies.map(tally => (
        <button
          key={tally.emoji}
          type="button"
          className={`live-chat-reaction ${tally.mine ? 'mine' : ''}`}
          disabled={!canReact || tally.mine}
          title={tally.mine ? 'You reacted with this' : `React with ${tally.emoji}`}
          onClick={() => react(tally.emoji)}
        >
          <span className="live-chat-reaction-emoji">{tally.emoji}</span>
          {tally.count > 1 && <span className="live-chat-reaction-count">{tally.count}</span>}
        </button>
      ))}

      {canReact && (
        <span className="live-chat-react-wrapper" ref={picker.containerRef}>
          <button
            ref={picker.triggerRef}
            type="button"
            className="live-chat-react-btn"
            title="React with an emoji"
            onClick={() => {
              if (pickerOpen) {
                setPickerOpen(false);
                return;
              }
              picker.openPopup();
              setPickerOpen(true);
            }}
          >
            ☺+
          </button>
          {pickerOpen && (
            <div className="live-chat-emoji-popup" ref={picker.popupRef} style={picker.style}>
              <EmojiPicker onSelect={react} />
            </div>
          )}
        </span>
      )}
    </span>
  );
};

export default LiveChatReactions;
