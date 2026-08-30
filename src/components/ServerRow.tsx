import React, { useState } from 'react';
import { useAnchoredPopup } from '../hooks/useAnchoredPopup';

interface ServerRowProps {
  url: string;
  label: string;
  active: boolean;
  muted: boolean;
  shared: boolean;
  onOpen: () => void;
  onShare: () => void;
  onToggleMute: () => void;
  onRemove: () => void;
}

/**
 * One server in the column, with what can be done to it on the server itself.
 *
 * Share used to sit as a single button under the whole list, which said
 * nothing about which server it meant the moment there were two. The menu
 * floats free of the column: the column scrolls, and anything drawn inside a
 * scrolling box is cut at its edge — which is exactly what happened to a menu
 * anchored in it.
 */
const ServerRow: React.FC<ServerRowProps> = ({
  url,
  label,
  active,
  muted,
  shared,
  onOpen,
  onShare,
  onToggleMute,
  onRemove
}) => {
  const [open, setOpen] = useState(false);
  const menu = useAnchoredPopup(open, () => setOpen(false));

  return (
    <div className={`groups-relay-row ${muted ? 'muted' : ''}`} ref={menu.containerRef}>
      <button
        type="button"
        className={`groups-relay ${active ? 'active' : ''}`}
        onClick={onOpen}
        title={url}
      >
        {label}
      </button>

      <button
        ref={menu.triggerRef}
        type="button"
        className="groups-relay-more"
        title={`What to do with ${label}`}
        onClick={() => { if (open) setOpen(false); else { menu.openPopup(); setOpen(true); } }}
      >
        ⋯
      </button>

      {open && menu.render(
        <div className="groups-relay-menu" ref={menu.popupRef} style={menu.style}>
          <button type="button" onClick={() => { onShare(); setOpen(false); }}>
            {shared ? 'Link copied' : 'Share server'}
          </button>
          <button type="button" onClick={() => { onToggleMute(); setOpen(false); }}>
            {muted ? 'Unmute server' : 'Mute server'}
          </button>
          <button
            type="button"
            className="groups-relay-remove"
            onClick={() => { onRemove(); setOpen(false); }}
          >
            Remove server
          </button>
        </div>
      )}
    </div>
  );
};

export default ServerRow;
