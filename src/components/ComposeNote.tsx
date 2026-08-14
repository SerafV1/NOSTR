import React, { useState, useRef, useEffect } from 'react';
import { nip19 } from 'nostr-tools';
import { NostrEventSigned, UserProfile } from '../types';
import { NostrCore, EventCache } from '../nostr/core';
import { BlossomClient } from '../nostr/blossom';
import { loadBlossomServers } from '../utils/blossomServers';
import {
  extractImageUrls,
  extractVideoUrls,
  extractEmbeds,
  extractPreviewLinkUrl,
  stripMediaUrls,
  splitContentTokens
} from '../utils/media';
import { extractMentionPubkeys, formatAddress } from '../utils/helpers';
import MediaEmbed from './MediaEmbed';
import LinkPreviewCard from './LinkPreviewCard';
import VideoPlayer from './VideoPlayer';
import EmojiPicker from './EmojiPicker';
import { PollIcon, PersonIcon, ZapIcon, ImageIcon } from './Icons';

const MAX_POLL_OPTIONS = 4;

interface ComposeNoteProps {
  onPublished?: (event: NostrEventSigned) => void;
  replyTo?: string;
  /** Note id to quote — a nostr:note1... reference is appended to the content */
  quoteNoteId?: string;
}

const ComposeNote: React.FC<ComposeNoteProps> = ({ onPublished, replyTo, quoteNoteId }) => {
  const [content, setContent] = useState('');
  // Debounced so the link card doesn't refetch on every keystroke
  const [previewLinkUrl, setPreviewLinkUrl] = useState<string | null>(null);
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [showPoll, setShowPoll] = useState(false);
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [pollType, setPollType] = useState<'user' | 'zap'>('user');
  const [pollDays, setPollDays] = useState(1);
  const [pollHours, setPollHours] = useState(0);
  const [pollMinutes, setPollMinutes] = useState(0);

  const [uploads, setUploads] = useState<{ name: string; progress: number }[]>([]);
  const [mediaServers] = useState(() => loadBlossomServers().filter(s => s.enabled));
  const [targetServer, setTargetServer] = useState(''); // '' = try every enabled server in order
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirrors `content` so concurrent uploads each append to the latest text
  // instead of racing against each other's stale closure
  const contentRef = useRef('');
  contentRef.current = content;

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

  const updatePollOption = (index: number, value: string) => {
    setPollOptions(prev => prev.map((o, i) => (i === index ? value : o)));
  };

  const addPollOption = () => {
    setPollOptions(prev => (prev.length < MAX_POLL_OPTIONS ? [...prev, ''] : prev));
  };

  const removePollOption = (index: number) => {
    setPollOptions(prev => prev.filter((_, i) => i !== index));
  };

  const removePoll = () => {
    setShowPoll(false);
    setPollOptions(['', '']);
    setPollType('user');
    setPollDays(1);
    setPollHours(0);
    setPollMinutes(0);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file later

    for (const file of files) {
      setUploads(prev => [...prev, { name: file.name, progress: 0 }]);
      try {
        const blob = await BlossomClient.uploadFile(file, targetServer || undefined, (progress) => {
          setUploads(prev => prev.map(u => (u.name === file.name ? { ...u, progress } : u)));
        });
        const separator = contentRef.current && !contentRef.current.endsWith('\n') ? '\n' : '';
        updateContent(`${contentRef.current}${separator}${blob.url} `);
      } catch (error) {
        console.error('Failed to upload file:', error);
        alert(error instanceof Error ? error.message : 'Failed to upload file');
      } finally {
        setUploads(prev => prev.filter(u => u.name !== file.name));
      }
    }
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
  // The link card fetches through the serverless proxy, so it waits for a
  // pause in typing instead of firing a request per keystroke. Mirrors
  // EventCard: only for a link that isn't already rendering as media.
  useEffect(() => {
    const url = extractPreviewLinkUrl(content);
    const hasMedia = extractImageUrls(content).length > 0
      || extractVideoUrls(content).length > 0
      || extractEmbeds(content).length > 0;
    if (!url || hasMedia) {
      setPreviewLinkUrl(null);
      return;
    }
    const timer = setTimeout(() => setPreviewLinkUrl(url), 800);
    return () => clearTimeout(timer);
  }, [content]);

  /**
   * The post's text as it will render once published: links, hashtags and
   * mentions styled the same way EventCard styles them, and media URLs
   * stripped out because they show up as their own previews below.
   */
  const renderLivePreview = (): React.ReactNode[] => {
    const handles = Array.from(mentionMapRef.current.keys()).sort((a, b) => b.length - a.length);
    const mentionPattern = handles.length
      ? new RegExp(`(${handles.map(h => `@${escapeRegExp(h)}`).join('|')})`, 'g')
      : null;

    const parts: React.ReactNode[] = [];
    let key = 0;

    for (const token of splitContentTokens(stripMediaUrls(content))) {
      if (token.type === 'link') {
        parts.push(<a key={key++} className="content-link">{token.value}</a>);
        continue;
      }
      if (token.type === 'hashtag') {
        parts.push(<span key={key++} className="hashtag-link">#{token.value}</span>);
        continue;
      }
      if (!mentionPattern) {
        parts.push(token.value);
        continue;
      }
      // Plain text can still contain an @handle picked from the mention list
      for (const piece of token.value.split(mentionPattern)) {
        if (!piece) continue;
        parts.push(
          piece.startsWith('@') && handles.some(h => piece === `@${h}`)
            ? <span key={key++} className="mention-link">{piece}</span>
            : piece
        );
      }
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
    const trimmedOptions = pollOptions.map(o => o.trim()).filter(Boolean);
    if (showPoll && trimmedOptions.length < 2) return;

    setPublishing(true);
    try {
      let event: NostrEventSigned | null;

      if (showPoll) {
        const totalSeconds = pollDays * 86400 + pollHours * 3600 + pollMinutes * 60;
        const endsAt = totalSeconds > 0 ? Math.floor(Date.now() / 1000) + totalSeconds : undefined;
        event = await NostrCore.publishPoll(content.trim(), trimmedOptions, pollType, endsAt);
      } else {
        let finalContent = resolveMentionHandles(content.trim());
        if (quoteNoteId) {
          try {
            finalContent += `\n\nnostr:${nip19.noteEncode(quoteNoteId)}`;
          } catch {
            finalContent += `\n\nnostr:${quoteNoteId}`;
          }
        }

        event = await NostrCore.publishNote(
          finalContent,
          replyTo,
          hashtags,
          extractMentionPubkeys(finalContent)
        );
      }

      if (event) {
        setContent('');
        setHashtags([]);
        setShowEmojiPicker(false);
        mentionMapRef.current.clear();
        removePoll();
        onPublished?.(event);
      } else {
        alert(`Failed to publish ${showPoll ? 'poll' : 'note'} — check that you are logged in`);
      }
    } catch (error) {
      console.error(`Error publishing ${showPoll ? 'poll' : 'note'}:`, error);
      alert(error instanceof Error ? error.message : `Error publishing ${showPoll ? 'poll' : 'note'}`);
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
          placeholder={showPoll ? 'Ask a question...' : quoteNoteId ? 'Add a comment...' : "What's on your mind?"}
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

      {showPoll && (
        <div className="compose-poll">
          {pollOptions.map((option, i) => (
            <div className="poll-option-row" key={i}>
              <input
                type="text"
                className="poll-option-input"
                placeholder={`Choice ${i + 1}`}
                value={option}
                maxLength={40}
                onChange={(e) => updatePollOption(i, e.target.value)}
                disabled={publishing}
              />
              {i >= 2 && (
                <button
                  type="button"
                  className="poll-option-remove"
                  onClick={() => removePollOption(i)}
                  title="Remove choice"
                >
                  ✕
                </button>
              )}
            </div>
          ))}

          {pollOptions.length < MAX_POLL_OPTIONS && (
            <button type="button" className="poll-add-choice" onClick={addPollOption}>
              + Add choice
            </button>
          )}

          <div className="poll-divider" />

          <div className="poll-section-label">
            Poll type <span className="poll-help" title="User Poll: one vote per person. Zap Poll: votes are weighted by zap amount.">?</span>
          </div>
          <div className="poll-type-toggle">
            <button
              type="button"
              className={`poll-type-btn ${pollType === 'user' ? 'active' : ''}`}
              onClick={() => setPollType('user')}
            >
              <PersonIcon /> User Poll
            </button>
            <button
              type="button"
              className={`poll-type-btn ${pollType === 'zap' ? 'active' : ''}`}
              onClick={() => setPollType('zap')}
            >
              <ZapIcon /> Zap Poll
            </button>
          </div>

          <div className="poll-divider" />

          <div className="poll-section-label">Poll length</div>
          <div className="poll-length-row">
            <select value={pollDays} onChange={(e) => setPollDays(Number(e.target.value))}>
              {Array.from({ length: 8 }, (_, i) => i).map(d => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
            <select value={pollHours} onChange={(e) => setPollHours(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, i) => i).map(h => (
                <option key={h} value={h}>{h} hours</option>
              ))}
            </select>
            <select value={pollMinutes} onChange={(e) => setPollMinutes(Number(e.target.value))}>
              {Array.from({ length: 60 }, (_, i) => i).map(m => (
                <option key={m} value={m}>{m} minutes</option>
              ))}
            </select>
          </div>

          <div className="poll-divider" />

          <button type="button" className="poll-remove-btn" onClick={removePoll}>
            🗑 Remove poll
          </button>
        </div>
      )}

      {!showPoll && (() => {
        // Live preview of the composed text. Shown for any post with text —
        // it used to appear only when the content happened to contain a
        // mention or hashtag, so writing an ordinary post looked like the
        // preview was broken.
        const previewParts = renderLivePreview();
        if (previewParts.length === 0) return null;
        return (
          <div className="compose-live-preview">
            <div className="compose-live-preview-label">Preview</div>
            <div className="compose-live-preview-text">{previewParts}</div>
          </div>
        );
      })()}

      {!showPoll && (() => {
        // Live preview of media links while typing
        const previewImages = extractImageUrls(content);
        const previewVideos = extractVideoUrls(content);
        const previewEmbeds = extractEmbeds(content);
        if (previewImages.length === 0 && previewVideos.length === 0 && previewEmbeds.length === 0) {
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
            {previewEmbeds.map(embed => (
              <MediaEmbed key={`${embed.kind}:${embed.id}`} embed={embed} />
            ))}
          </div>
        );
      })()}

      {!showPoll && previewLinkUrl && (
        <div className="compose-preview">
          <LinkPreviewCard url={previewLinkUrl} />
        </div>
      )}

      {uploads.length > 0 && (
        <div className="compose-upload-status">
          {uploads.map(u => (
            <div key={u.name} className="compose-upload-row">
              <span className="compose-upload-name">{u.name}</span>
              <div className="compose-upload-bar">
                <div className="compose-upload-bar-fill" style={{ width: `${u.progress}%` }} />
              </div>
              <span className="compose-upload-pct">{u.progress}%</span>
            </div>
          ))}
        </div>
      )}

      <div className="compose-actions">
        <div className="compose-actions-left">
          {!showPoll && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                onChange={handleFileSelect}
              />
              <button
                type="button"
                className="compose-media-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploads.length > 0}
                title="Add photo/video"
              >
                <ImageIcon />
              </button>
              {mediaServers.length > 1 && (
                <select
                  className="compose-server-select"
                  value={targetServer}
                  onChange={(e) => setTargetServer(e.target.value)}
                  title="Media server to upload to"
                  disabled={uploads.length > 0}
                >
                  <option value="">Auto (try all)</option>
                  {mediaServers.map(s => (
                    <option key={s.url} value={s.url}>{s.url.replace(/^https?:\/\//, '')}</option>
                  ))}
                </select>
              )}
            </>
          )}
          {!replyTo && !quoteNoteId && !showPoll && (
            <button
              type="button"
              className="compose-poll-btn"
              onClick={() => setShowPoll(true)}
              title="Add poll"
            >
              <PollIcon />
            </button>
          )}
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
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!content.trim() || publishing || uploads.length > 0 || (showPoll && pollOptions.filter(o => o.trim()).length < 2)}
        >
          {publishing ? 'Publishing...' : showPoll ? 'Post' : (replyTo ? 'Reply' : quoteNoteId ? 'Quote' : 'Publish')}
        </button>
      </div>
    </form>
  );
};

export default ComposeNote;
