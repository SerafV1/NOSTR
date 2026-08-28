import React from 'react';
import { CustomEmojiMap, splitCustomEmoji } from '../utils/customEmoji';

interface EmojiTextProps {
  text: string;
  emojis?: CustomEmojiMap;
  className?: string;
}

/**
 * Text with its NIP-30 custom emoji drawn as pictures. Used for names, which
 * are plain strings almost everywhere and would otherwise read ":ggstr:".
 */
const EmojiText: React.FC<EmojiTextProps> = ({ text, emojis, className }) => {
  const pieces = splitCustomEmoji(text, emojis || {});
  if (pieces.every(piece => piece.type === 'text')) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {pieces.map((piece, index) => (
        piece.type === 'emoji'
          ? <img key={index} src={piece.url} alt={`:${piece.value}:`} className="custom-emoji"  loading="lazy" decoding="async" />
          : <React.Fragment key={index}>{piece.value}</React.Fragment>
      ))}
    </span>
  );
};

export default EmojiText;
