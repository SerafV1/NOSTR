import React from 'react';
import RichText from './RichText';

interface MarkdownProps {
  /** The article's body, as NIP-23 says it is written: markdown */
  content: string;
  emojis?: Record<string, string>;
  onNavigateToProfile: (pubkey: string) => void;
  onNavigateToNote?: (noteId: string) => void;
  onNavigateToTopic?: (topic: string) => void;
}

/**
 * Long-form articles (NIP-23) carry markdown, which nothing else in this app
 * has had to read.
 *
 * The blocks are parsed here and the text inside them is handed to RichText,
 * so an `nostr:npub…` in the middle of a paragraph is still a person, a
 * hashtag is still a hashtag, and a picture is still shown — none of which a
 * markdown library would know about. Nothing is ever turned into HTML: every
 * piece of an article is a React element, so a page that is someone else's
 * writing cannot become someone else's script.
 */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'image'; url: string; alt: string }
  | { kind: 'rule' };

/** A line that is nothing but a picture, which is how articles carry them */
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;

function parse(content: string): Block[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // A fence runs until it is closed, or to the end — an unclosed fence in
    // somebody's article should not swallow the rest of the page as text
    const fence = /^```(\w+)?\s*$/.exec(trimmed);
    if (fence) {
      closeParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'code', text: body.join('\n'), language: fence[1] });
      continue;
    }

    if (trimmed === '') {
      closeParagraph();
      continue;
    }

    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      closeParagraph();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeParagraph();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const picture = IMAGE_LINE.exec(trimmed);
    if (picture) {
      closeParagraph();
      blocks.push({ kind: 'image', url: picture[2], alt: picture[1] });
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      closeParagraph();
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'quote', text: quoted.join('\n') });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      closeParagraph();
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i].trim();
        const asBullet = /^[-*+]\s+(.*)$/.exec(next);
        const asNumber = /^\d+[.)]\s+(.*)$/.exec(next);
        const match = ordered ? asNumber : asBullet;
        if (!match) break;
        items.push(match[1]);
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    paragraph.push(trimmed);
  }

  closeParagraph();
  return blocks;
}

/**
 * The marks that live inside a line. Kept to the four that carry meaning —
 * bold, italic, inline code and links — because everything else in an article
 * is a nostr reference, a picture or a plain URL, and RichText already knows
 * what to do with those.
 */
const LINK_TARGET = String.raw`(?:[^()\s]|\([^()\s]*\))+`;
const INLINE = new RegExp(
  String.raw`(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|` + '`' + String.raw`[^` + '`' + String.raw`\n]+` + '`' + String.raw`|\[[^\]\n]*\]\(${LINK_TARGET}\))`,
  'g'
);

const Inline: React.FC<{ text: string } & Omit<MarkdownProps, 'content'>> = ({
  text,
  emojis,
  onNavigateToProfile,
  onNavigateToNote,
  onNavigateToTopic
}) => {
  const rich = (piece: string, key: React.Key) => (
    <RichText
      key={key}
      content={piece}
      emojis={emojis}
      onNavigateToProfile={onNavigateToProfile}
      onNavigateToNote={onNavigateToNote}
      onNavigateToTopic={onNavigateToTopic}
    />
  );

  const pieces = text.split(INLINE);
  return (
    <>
      {pieces.map((piece, index) => {
        if (!piece) return null;
        if (index % 2 === 0) return rich(piece, index);

        if (piece.startsWith('**') || piece.startsWith('__')) {
          return <strong key={index}>{rich(piece.slice(2, -2), `${index}i`)}</strong>;
        }
        if (piece.startsWith('`')) {
          return <code key={index} className="markdown-code-inline">{piece.slice(1, -1)}</code>;
        }
        if (piece.startsWith('[')) {
          const link = new RegExp(String.raw`^\[([^\]]*)\]\((${LINK_TARGET})\)$`).exec(piece);
          if (link) {
            const [, label, href] = link;
            // Only addresses a browser should follow — a `javascript:` link
            // written into an article is exactly the thing this page must not
            // hand to a reader
            const safe = /^(https?:|nostr:|mailto:|lightning:|bitcoin:|monero:)/i.test(href);
            return safe ? (
              <a key={index} href={href} target="_blank" rel="noopener noreferrer nofollow">
                {label || href}
              </a>
            ) : (
              <span key={index}>{label || href}</span>
            );
          }
        }
        if (piece.startsWith('*') || piece.startsWith('_')) {
          return <em key={index}>{rich(piece.slice(1, -1), `${index}i`)}</em>;
        }
        return rich(piece, index);
      })}
    </>
  );
};

const Markdown: React.FC<MarkdownProps> = ({ content, ...rest }) => {
  const blocks = parse(content || '');

  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${Math.min(block.level + 1, 6)}` as keyof JSX.IntrinsicElements;
            return <Tag key={index}><Inline text={block.text} {...rest} /></Tag>;
          }
          case 'quote':
            return (
              <blockquote key={index}>
                <Inline text={block.text} {...rest} />
              </blockquote>
            );
          case 'code':
            return (
              <pre key={index} className="markdown-code">
                <code>{block.text}</code>
              </pre>
            );
          case 'list':
            return block.ordered ? (
              <ol key={index}>
                {block.items.map((item, n) => <li key={n}><Inline text={item} {...rest} /></li>)}
              </ol>
            ) : (
              <ul key={index}>
                {block.items.map((item, n) => <li key={n}><Inline text={item} {...rest} /></li>)}
              </ul>
            );
          case 'image':
            return (
              <img
                key={index}
                src={block.url}
                alt={block.alt}
                className="markdown-image"
                loading="lazy"
                decoding="async"
              />
            );
          case 'rule':
            return <hr key={index} />;
          default:
            return <p key={index}><Inline text={block.text} {...rest} /></p>;
        }
      })}
    </div>
  );
};

export default Markdown;
