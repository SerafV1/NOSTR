import React from 'react';

interface RazrLogoProps {
  className?: string;
  size?: number;
}

/**
 * A razor blade, edge-on: the shape of a double-edge blade — rounded body,
 * the long central slot — with one edge catching the light and the other in
 * shadow, so it reads as sharp rather than as a plain rounded rectangle.
 *
 * Drawn rather than shipped as an image so it stays crisp at any size and
 * takes the app's own colours.
 */
const RazrLogo: React.FC<RazrLogoProps> = ({ className, size = 26 }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    role="img"
    aria-label="RAZR"
  >
    <defs>
      <linearGradient id="razr-body" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="var(--primary-color, #667eea)" />
        <stop offset="1" stopColor="var(--secondary-color, #764ba2)" />
      </linearGradient>
      <linearGradient id="razr-edge" x1="6" y1="6" x2="26" y2="10" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
        <stop offset="1" stopColor="#fff" stopOpacity="0.15" />
      </linearGradient>
    </defs>

    {/* The blade, tilted so the edge runs across the mark */}
    <g transform="rotate(-35 16 16)">
      {/* Slimmer than a slab, and the edge is the whole point of the shape */}
      <path d="M4 11.5h24a2.5 2.5 0 0 1 2.5 2.5v3.4a2.5 2.5 0 0 1-2.5 2.5H4a2.5 2.5 0 0 1-2.5-2.5V14A2.5 2.5 0 0 1 4 11.5Z" fill="url(#razr-body)" />
      {/* The slot a blade is held by */}
      <rect x="10" y="14.6" width="12" height="2.4" rx="1.2" fill="var(--dark-bg, #0f0f1e)" />
      {/* One edge catches the light, the other falls into shadow — that
          contrast is what makes it read as sharp at 26 pixels */}
      <path d="M4 11.5h24a2.5 2.5 0 0 1 2.4 1.9H1.6A2.5 2.5 0 0 1 4 11.5Z" fill="url(#razr-edge)" />
      <path d="M1.6 17.6h28.8A2.5 2.5 0 0 1 28 19.9H4a2.5 2.5 0 0 1-2.4-2.3Z" fill="#000" opacity="0.3" />
    </g>
  </svg>
);

export default RazrLogo;
