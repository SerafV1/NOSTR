import { useCallback, useEffect, useLayoutEffect, useRef, useState, CSSProperties } from 'react';

/**
 * Every open popup, so opening one closes the rest. Two of them at once
 * float over the page from fixed positions and land on top of each other.
 */
const openPopups = new Set<() => void>();

/** Below this width the popups become bottom sheets in CSS — see index.css */
const SHEET_BREAKPOINT = 768;

/**
 * bottom/right/margin/transform are cleared, not just left unset: the CSS
 * anchors these popups to their trigger, and a fixed element with both edges
 * set stretches between them instead of taking its own size.
 */
const FREED_FROM_FLOW: CSSProperties = {
  position: 'fixed',
  bottom: 'auto',
  right: 'auto',
  margin: 0,
  transform: 'none'
};

interface AnchoredPopup {
  /** Wraps trigger and popup, so a click inside is not "outside" */
  containerRef: React.RefObject<HTMLDivElement>;
  triggerRef: React.RefObject<HTMLButtonElement>;
  popupRef: React.RefObject<HTMLDivElement>;
  /** Apply to the popup element */
  style: CSSProperties;
  /** Call instead of setting the open flag directly, to dismiss the others */
  openPopup: () => void;
}

/**
 * A popup anchored to its trigger but positioned against the viewport.
 *
 * Both the emoji picker and the zap picker hang off a button inside the live
 * chat, and that panel clips whatever reaches outside it — a 280px panel
 * anchored to a button at the panel's edge was cut down to a strip. Fixed
 * positioning escapes the clipping, at the cost of having to work the
 * position out here: beside the trigger, above it where there is room,
 * never off an edge of the screen.
 *
 * Narrow screens are left alone: there is no good anchor for a panel that
 * wide, so the CSS turns it into a sheet across the bottom instead.
 */
export function useAnchoredPopup(
  open: boolean,
  onClose: () => void,
  /** Anything that changes the popup's size, so it can be placed again */
  remeasure: unknown[] = []
): AnchoredPopup {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const [measured, setMeasured] = useState(false);

  /** Place it against the trigger, wherever the trigger is now */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;

    const margin = 8;
    const t = trigger.getBoundingClientRect();
    const p = popup.getBoundingClientRect();

    let top = t.top - p.height - margin;
    if (top < margin) {
      top = Math.min(t.bottom + margin, window.innerHeight - p.height - margin);
    }
    const left = Math.min(
      Math.max(margin, t.left),
      Math.max(margin, window.innerWidth - p.width - margin)
    );

    setStyle({ ...FREED_FROM_FLOW, top: Math.max(margin, top), left, visibility: 'visible' });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: 'hidden' });
      setMeasured(false);
      return;
    }
    if (window.innerWidth <= SHEET_BREAKPOINT) {
      setStyle({});
      return;
    }

    // Measured in two passes. Left in the flow, the popup is only as wide as
    // the button it hangs off, which makes it far taller than it will end up
    // — and a position worked out from that height leaves it floating well
    // above its trigger. So it is taken out of the flow first, at a corner
    // where it can size itself freely, and measured on the next pass.
    if (!measured) {
      setStyle({ ...FREED_FROM_FLOW, top: 0, left: 0, visibility: 'hidden' });
      setMeasured(true);
      return;
    }

    place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, measured, place, ...remeasure]);

  // Another popup opening dismisses this one, as does a click outside or
  // Escape. Scrolling only moves it: a live chat scrolls itself to the bottom
  // on every new message, so closing on scroll meant the picker vanished the
  // moment anyone said anything. It follows its trigger instead, and gives up
  // only once the trigger has scrolled out of sight.
  useEffect(() => {
    if (!open) return;

    const follow = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      if (t.bottom < 0 || t.top > window.innerHeight) {
        onClose();
        return;
      }
      place();
    };
    const closeOnOutside = (e: Event) => {
      if (!containerRef.current?.contains(e.target as Node)) onClose();
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    openPopups.add(onClose);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      openPopups.delete(onClose);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place]);

  return {
    containerRef,
    triggerRef,
    popupRef,
    style,
    openPopup: () => openPopups.forEach(close => close())
  };
}
