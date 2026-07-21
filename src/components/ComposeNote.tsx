import React, { useState, useRef, useEffect } from 'react';
import { nip19 } from 'nostr-tools';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { extractImageUrls, extractVideoUrls, extractYouTubeIds } from '../utils/media';
import { extractMentionPubkeys, formatAddress } from '../utils/helpers';
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

  // @mention autocomplete: mentionStart is the index of the triggering '@'
  // in `content`, or null when we're not in mention-typing mode
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionSuggestions, setMentionSuggestions] = useState<UserProfile[]>([]);
  const mentionRequestId = useRef(0);
  const mentionWrapperRef = useRef<HTMLDivElement>(null);
  // Tracks handle -> pubkey for mentions inserted this session, so the
  // textarea can show a readable "@handle" while typing but the published
  // note still carries a proper nostr:npub reference (and 'p' tag) for it
  const mentionMapRef = useRef<Map<string, string>>(new Map());

  // Close the mention dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (mentionWrapperRef.current && !mentionWrapperRef.current.contains(e.target as Node)) {
        setMentionStart(null);
        setMentionQuery('');
        setMentionSuggestions([]);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

  // Look backward from the cursor for an active "@query" being typed —
  // it must start at the beginning of the text or right after whitespace,
  // and contain no whitespace itself, otherwise we're not mentioning anyone
  const detectMentionTrigger = (text: string, cursor: number) => {
    const uptoCursor = text.slice(0, cursor);
    const at = uptoCursor.lastIndexOf('@');
    if (at === -1) return null;
    if (at > 0 && !/\s/.test(uptoCursor[at - 1])) return null;
    const query = uptoCursor.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { start: at, query };
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    updateContent(newContent);

    const cursor = e.target.selectionStart ?? newContent.length;
    const trigger = detectMentionTrigger(newContent, cursor);
    if (trigger) {
      setMentionStart(trigger.start);
      setMentionQuery(trigger.query);
    } else {
      setMentionStart(null);
      setMentionQuery('');
      setMentionSuggestions([]);
    }
  };

  // Debounced people search while an "@query" is active: instant results
  // from the local profile cache, refined by a relay query once typing pauses
  useEffect(() => {
    if (mentionStart === null) return;

    const fromCache = EventCache.getAllProfiles()
      .filter(p => [p.name, p.display_name, p.nip05]
        .filter(Boolean).join(' ').toLowerCase().includes(mentionQuery.toLowerCase()))
      .slice(0, 5);
    setMentionSuggestions(fromCache);

    if (!mentionQuery.trim()) return;

    const requestId = ++mentionRequestId.current;
    const timer = setTimeout(async () => {
      try {
        const results = await NostrCore.searchProfiles(mentionQuery.trim(), 5);
        if (mentionRequestId.current === requestId) {
          setMentionSuggestions(results);
        }
      } catch (error) {
        console.error('Failed to load mention suggestions:', error);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [mentionQuery, mentionStart]);

  const selectMention = (profile: UserProfile) => {
    if (mentionStart === null) return;
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? mentionStart + 1 + mentionQuery.length;
    // Show a readable handle while typing — the raw npub is substituted
    // back in at publish time via mentionMapRef
    const handle = profile.name || profile.display_name || profile.nip05 || formatAddress(profile.pubkey);
    const mentionText = `@${handle} `;
    const newContent = content.slice(0, mentionStart) + mentionText + content.slice(cursor);
    updateContent(newContent);
    mentionMapRef.current.set(handle, profile.pubkey);

    setMentionStart(null);
    setMentionQuery('');
    setMentionSuggestions([]);

    requestAnimationFrame(() => {
      textarea?.focus();
      const newCursor = mentionStart + mentionText.length;
      textarea?.setSelectionRange(newCursor, newCursor);
    });
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

  const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Swap "@handle" back into a nostr:npub reference for every mention
  // selected from the dropdown this session, so the published note is a
  // real reference even though the textarea only ever showed the handle
  const resolveMentionHandles = (text: string): string => {
    let result = text;
    for (const [handle, pubkey] of mentionMapRef.current) {
      const pattern = new RegExp(`@${escapeRegExp(handle)}(?=[\\s.,!?;:]|$)`, 'g');
      result = result.replace(pattern, `nostr:${nip19.npubEncode(pubkey)}`);
    }
    return result;
  };

  // Live preview of the composed text with mentions and hashtags styled
  // the same way they'll render once published, for both post and reply
  const renderLivePreview = (): React.ReactNode[] => {
    const handles = Array.from(mentionMapRef.current.keys()).sort((a, b) => b.length - a.length);
    const mentionAlt = handles.length ? handles.map(h => `@${escapeRegExp(h)}`).join('|') + '|' : '';
    const pattern = new RegExp(`(${mentionAlt}#[\\w]+)`, 'g');

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    while ((match = pattern.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push(content.slice(lastIndex, match.index));
      }
      const token = match[0];
      parts.push(
        <span key={key++} className={token.startsWith('#') ? 'hashtag-link' : 'mention-link'}>
          {token}
        </span>
      );
      lastIndex = match.index + token.length;
    }
    if (lastIndex < content.length) {
      parts.push(content.slice(lastIndex));
    }
    return parts;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && mentionStart !== null) {
      setMentionStart(null);
      setMentionQuery('');
      setMentionSuggestions([]);
      return;
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      handlePublish(e as any);
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setPublishing(true);
    try {
      let finalContent = resolveMentionHandles(content.trim());
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
        hashtags,
        extractMentionPubkeys(finalContent)
      );

      if (event) {
        setContent('');
        setHashtags([]);
        setShowEmojiPicker(false);
        mentionMapRef.current.clear();
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
      <div className="compose-textarea-wrapper" ref={mentionWrapperRef}>
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

        {mentionStart !== null && mentionSuggestions.length > 0 && (
          <div className="mention-suggestions">
            {mentionSuggestions.map(profile => (
              <button
                key={profile.pubkey}
                type="button"
                className="suggestion-item"
                onClick={() => selectMention(profile)}
              >
                {profile.picture ? (
                  <img src={profile.picture} alt="" className="suggestion-avatar" />
                ) : (
                  <span className="suggestion-avatar-placeholder">
                    {(profile.display_name || profile.name || '?').charAt(0).toUpperCase()}
                  </span>
                )}
                <span>{profile.display_name || profile.name || formatAddress(profile.pubkey)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {(() => {
        // Live preview of the composed text, with mentions/hashtags styled
        // the same way they'll look once published
        const previewParts = renderLivePreview();
        if (!content.trim() || !previewParts.some(part => typeof part !== 'string')) {
          return null;
        }
        return (
          <div className="compose-live-preview">
            <div className="compose-live-preview-label">Preview</div>
            <div className="compose-live-preview-text">{previewParts}</div>
          </div>
        );
      })()}

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
