import React, { useState } from 'react';
import EmojiPicker from './EmojiPicker';
import { useAnchoredPopup } from '../hooks/useAnchoredPopup';

export interface ReactionTally {
  emoji: string;
  count: number;
  /** Already reacted with this one — reacting twice says nothing new */
  mine: boolean;
  /** NIP-30 custom emoji: the picture behind a `:shortcode:` */
  image?: string;
}

/**
 * A busy message can collect more kinds of reaction than fit beside it in a
 * chat this narrow, so the tail is folded away until asked for.
 */
const COLLAPSED_KINDS = 6;

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
  const [expanded, setExpanded] = useState(false);
  const picker = useAnchoredPopup(pickerOpen, () => setPickerOpen(false));

  const shown = expanded ? tallies : tallies.slice(0, COLLAPSED_KINDS);
  const hidden = tallies.length - shown.length;

  const react = (emoji: string) => {
    setPickerOpen(false);
    onReact(emoji);
  };

  return (
    <span className="live-chat-reactions">
      {shown.map(tally => (
        <button
          key={tally.emoji}
          type="button"
          className={`live-chat-reaction ${tally.mine ? 'mine' : ''}`}
          disabled={!canReact || tally.mine}
          title={`${tally.count} × ${tally.emoji}${tally.mine ? ' — including you' : ''}`}
          onClick={() => react(tally.emoji)}
        >
          {tally.image ? (
            <img src={tally.image} alt={tally.emoji} className="live-chat-reaction-image" />
          ) : (
            <span className="live-chat-reaction-emoji">{tally.emoji}</span>
          )}
          {tally.count > 1 && <span className="live-chat-reaction-count">{tally.count}</span>}
        </button>
      ))}

      {hidden > 0 && (
        <button
          type="button"
          className="live-chat-reaction live-chat-reaction-rest"
          title={`Show ${hidden} more`}
          onClick={() => setExpanded(true)}
        >
          +{hidden}
        </button>
      )}

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
          {pickerOpen && picker.render(
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
