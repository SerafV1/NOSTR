import React from 'react';

interface RazrWordmarkProps {
  className?: string;
  /** Height in pixels; the width follows the word */
  height?: number;
}

/**
 * RAZR, cut.
 *
 * One diagonal pass through the word: the halves separate along it and the
 * top slides a little way down the cut, the way two pieces do once something
 * sharp has been through them. The cut itself carries a hairline of light,
 * without which — at the size this sits in the header — the offset reads as
 * a font that failed to render rather than as a deliberate slice.
 */
const RazrWordmark: React.FC<RazrWordmarkProps> = ({ className, height = 26 }) => {
  // One id set per instance, or two marks on a page share gradients and clips
  const uid = React.useId().replace(/:/g, '');
  const word = { fontFamily: 'Carlito, sans-serif', fontWeight: 700, fontSize: 52, letterSpacing: 5 };

  return (
    <svg
      className={className}
      viewBox="0 0 200 60"
      height={height}
      fill="none"
      role="img"
      aria-label="RAZR"
    >
      <defs>
        <linearGradient id={`${uid}-ink`} x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--primary-color, #667eea)" />
          <stop offset="1" stopColor="var(--accent-color, #c07be0)" />
        </linearGradient>
        {/* The cut runs from lower left to upper right; each half keeps its
            own side of it */}
        <clipPath id={`${uid}-above`}>
          <polygon points="0,0 200,0 200,17 0,33" />
        </clipPath>
        <clipPath id={`${uid}-below`}>
          <polygon points="0,37 200,21 200,60 0,60" />
        </clipPath>
        {/* The glint fades out at both ends: a hard-ended line across the
            whole width reads as a strikethrough, not as a cut */}
        <linearGradient id={`${uid}-glint`} x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.12" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="0.82" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>

      <g fill={`url(#${uid}-ink)`} {...word}>
        {/* The upper half, slid along the cut */}
        <text x="2" y="45" clipPath={`url(#${uid}-above)`} transform="translate(6 -1)">RAZR</text>
        <text x="2" y="45" clipPath={`url(#${uid}-below)`}>RAZR</text>
      </g>

      {/* The edge that did it */}
      <path d="M0 34.6 L200 18.6 L200 20.2 L0 36.2 Z" fill={`url(#${uid}-glint)`} />
    </svg>
  );
};

export default RazrWordmark;
