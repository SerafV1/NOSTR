import React, { useState, useRef } from 'react';
import { nip19 } from 'nostr-tools';
import { NostrEventSigned } from '../types';
import { NostrCore } from '../nostr/core';
import { extractImageUrls, extractVideoUrls, extractYouTubeIds } from '../utils/media';
import VideoPlayer from './VideoPlayer';
import EmojiPicker from './EmojiPicker';

interface ComposeNoteProps {
  onPublished?: (event: NostrEventSigned) => void;
  replyTo?: string;
  /** Note id to quote — a nostr:note1... reference is appended to the content */
  quoteNoteId?: string;
}

const ComposeNote: React.FC<ComposeNoteProps> = ({ onPublished, replyTo, quoteNoteId }) => {
  const [content, setContent] = useState('');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Extract hashtags from content automatically
  const extractHashtagsFromContent = (text: string): string[] => {
    const hashtagRegex = /#[\w]+/g;
    const matches = text.match(hashtagRegex) || [];
    const tags = matches.map(tag => tag.slice(1).toLowerCase());
    return [...new Set(tags)]; // Remove duplicates
  };

  const updateContent = (newContent: string) => {
    setContent(newContent);
    setHashtags(extractHashtagsFromContent(newContent));
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateContent(e.target.value);
  };

  const insertEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      updateContent(content + emoji);
      return;
    }

    const start = textarea.selectionStart ?? content.length;
    const end = textarea.selectionEnd ?? content.length;
    updateContent(content.slice(0, start) + emoji + content.slice(end));

    // Restore focus/cursor after the re-render that follows setContent
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + emoji.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handlePublish(e as any);
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setPublishing(true);
    try {
      let finalContent = content.trim();
      if (quoteNoteId) {
        try {
          finalContent += `\n\nnostr:${nip19.noteEncode(quoteNoteId)}`;
        } catch {
          finalContent += `\n\nnostr:${quoteNoteId}`;
        }
      }

      const event = await NostrCore.publishNote(
        finalContent,
        replyTo,
        hashtags
      );

      if (event) {
        setContent('');
        setHashtags([]);
        setShowEmojiPicker(false);
        onPublished?.(event);
      } else {
        alert('Failed to publish note — check that you are logged in');
      }
    } catch (error) {
      console.error('Error publishing note:', error);
      alert(error instanceof Error ? error.message : 'Error publishing note');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <form className="compose-note" onSubmit={handlePublish}>
      <textarea
        ref={textareaRef}
        className="compose-textarea"
        placeholder={quoteNoteId ? 'Add a comment...' : "What's on your mind?"}
        value={content}
        onChange={handleContentChange}
        onKeyDown={handleKeyDown}
        rows={replyTo || quoteNoteId ? 3 : 4}
        disabled={publishing}
      />

      {(() => {
        // Live preview of media links while typing
        const previewImages = extractImageUrls(content);
        const previewVideos = extractVideoUrls(content);
        const previewYouTube = extractYouTubeIds(content);
        if (previewImages.length === 0 && previewVideos.length === 0 && previewYouTube.length === 0) {
          return null;
        }
        return (
          <div className="compose-preview">
            {previewImages.map(url => (
              <img
                key={url}
                src={url}
                alt="Preview"
                className="compose-preview-img"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ))}
            {previewVideos.map(url => (
              <VideoPlayer key={url} src={url} className="compose-preview-video" />
            ))}
            {previewYouTube.map(videoId => (
              <div key={videoId} className="event-video-embed">
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${videoId}`}
                  title="YouTube preview"
                  allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            ))}
          </div>
        );
      })()}

      <div className="compose-actions">
        <div className="compose-emoji-wrapper">
          <button
            type="button"
            className="compose-emoji-btn"
            onClick={() => setShowEmojiPicker(show => !show)}
            title="Add emoji"
          >
            😊
          </button>
          {showEmojiPicker && (
            <div className="compose-emoji-popup">
              <EmojiPicker onSelect={insertEmoji} />
            </div>
          )}
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!content.trim() || publishing}
        >
          {publishing ? 'Publishing...' : (replyTo ? 'Reply' : quoteNoteId ? 'Quote' : 'Publish')}
        </button>
      </div>
    </form>
  );
};

export default ComposeNote;
