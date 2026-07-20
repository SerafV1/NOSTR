import React from 'react';
import { NostrEventSigned } from '../types';
import ComposeNote from './ComposeNote';

interface ComposeContext {
  authorName: string;
  authorPicture?: string;
  content: string;
}

interface ComposeModalProps {
  title: string;
  replyTo?: string;
  quoteNoteId?: string;
  /** Compact preview of the post being replied to/quoted, shown above the composer */
  context?: ComposeContext;
  onClose: () => void;
  onPublished: (event: NostrEventSigned) => void;
}

const ComposeModal: React.FC<ComposeModalProps> = ({
  title,
  replyTo,
  quoteNoteId,
  context,
  onClose,
  onPublished
}) => {
  return (
    <div className="compose-modal-overlay" onClick={onClose}>
      <div className="compose-modal" onClick={(e) => e.stopPropagation()}>
        <div className="compose-modal-header">
          <button className="compose-modal-close" onClick={onClose} title="Close">
            ✕
          </button>
          <span className="compose-modal-title">{title}</span>
        </div>

        {context && (
          <div className="compose-modal-context">
            {context.authorPicture ? (
              <img src={context.authorPicture} alt="" className="compose-modal-context-avatar" />
            ) : (
              <div className="compose-modal-context-avatar-placeholder">
                {(context.authorName || '?').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="compose-modal-context-body">
              <span className="compose-modal-context-name">{context.authorName}</span>
              <p className="compose-modal-context-text">{context.content}</p>
            </div>
          </div>
        )}

        <ComposeNote
          replyTo={replyTo}
          quoteNoteId={quoteNoteId}
          onPublished={(event) => {
            onPublished(event);
            onClose();
          }}
        />
      </div>
    </div>
  );
};

export default ComposeModal;
