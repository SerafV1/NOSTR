import { useEffect, useLayoutEffect, useRef, useState, CSSProperties } from 'react';

/**
 * Every open popup, so opening one closes the rest. Two of them at once
 * float over the page from fixed positions and land on top of each other.
 */
const openPopups = new Set<() => void>();

/** Below this width the popups become bottom sheets in CSS — see index.css */
const SHEET_BREAKPOINT = 768;

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

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: 'hidden' });
      return;
    }
    if (window.innerWidth <= SHEET_BREAKPOINT) {
      setStyle({});
      return;
    }

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

    // bottom/right are cleared because the CSS anchors these popups to their
    // trigger — left with those set, a fixed element stretches between edges
    setStyle({
      position: 'fixed',
      top: Math.max(margin, top),
      left,
      bottom: 'auto',
      right: 'auto',
      margin: 0,
      transform: 'none',
      visibility: 'visible'
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...remeasure]);

  // Everything that should dismiss it: another popup opening, a click outside,
  // Escape, and scrolling — anchored to a point in the viewport, it would
  // otherwise hang there while the message it belongs to scrolls away.
  useEffect(() => {
    if (!open) return;

    const closeOnOutside = (e: Event) => {
      if (!containerRef.current?.contains(e.target as Node)) onClose();
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    openPopups.add(onClose);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      openPopups.delete(onClose);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return {
    containerRef,
    triggerRef,
    popupRef,
    style,
    openPopup: () => openPopups.forEach(close => close())
  };
}
