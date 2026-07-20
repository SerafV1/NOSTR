import React, { useState } from 'react';
import { EMOJI_CATEGORIES } from '../utils/emojis';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

const CATEGORY_ICONS: Record<string, string> = {
  Smileys: '😀',
  Gestures: '👍',
  Hearts: '❤️',
  Nature: '🌸',
  Food: '🍕',
  Activities: '⚽',
  Symbols: '✅'
};

const EmojiPicker: React.FC<EmojiPickerProps> = ({ onSelect }) => {
  const categories = Object.keys(EMOJI_CATEGORIES);
  const [active, setActive] = useState(categories[0]);

  return (
    <div className="emoji-picker" onClick={(e) => e.stopPropagation()}>
      <div className="emoji-picker-tabs">
        {categories.map(category => (
          <button
            key={category}
            type="button"
            className={`emoji-picker-tab ${active === category ? 'active' : ''}`}
            title={category}
            onClick={() => setActive(category)}
          >
            {CATEGORY_ICONS[category] || '•'}
          </button>
        ))}
      </div>
      <div className="emoji-picker-grid">
        {EMOJI_CATEGORIES[active].map((emoji, index) => (
          <button
            key={`${emoji}-${index}`}
            type="button"
            className="emoji-picker-item"
            onClick={() => onSelect(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
};

export default EmojiPicker;
