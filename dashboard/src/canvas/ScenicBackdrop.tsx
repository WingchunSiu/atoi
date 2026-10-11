// An original engraving-style coastal landscape for the "scenic" theme: hatched mountains,
// a lined sea, a headland with cypresses and a bell tower, a sailboat and clouds. Drawn in
// one ink color with line patterns, like a copperplate print. Hidden in other themes.
import { memo } from "react";

const INK = "var(--color-engraving, #1e4f9c)";

/** A cypress: a tall flame shape, cross-hatched. */
function Cypress({ x, y, h }: { x: number; y: number; h: number }) {
  const w = h * 0.16;
  return (
    <path
      d={`M ${x} ${y - h} C ${x + w * 0.7} ${y - h * 0.72} ${x + w} ${y - h * 0.3} ${x + w * 0.45} ${y}
          L ${x - w * 0.45} ${y} C ${x - w} ${y - h * 0.3} ${x - w * 0.7} ${y - h * 0.72} ${x} ${y - h} Z`}
      fill="url(#eng-cross)"
      stroke={INK}
      strokeWidth={1.1}
    />
  );
}

function Cloud({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <path
      transform={`translate(${x} ${y}) scale(${s})`}
      d="M 0 40 C -6 26 10 16 26 22 C 30 4 58 -2 72 14 C 84 0 112 2 118 22 C 136 16 156 26 150 40
         C 158 50 146 58 134 54 L 14 54 C 0 56 -8 48 0 40 Z"
      fill="url(#eng-dots)"
      stroke={INK}
      strokeWidth={1.1 / s}
    />
  );
}

export const ScenicBackdrop = memo(function ScenicBackdrop() {
  return (
    <svg
      className="atoi-backdrop pointer-events-none absolute inset-x-0 bottom-0 h-[58%] w-full"
      viewBox="0 0 1600 520"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden
      style={{ opacity: 0.5 }}
    >
      <defs>
        <pattern id="eng-h-fine" width="8" height="5" patternUnits="userSpaceOnUse">
          <line x1="0" y1="2.5" x2="8" y2="2.5" stroke={INK} strokeWidth="1.2" />
        </pattern>
        <pattern id="eng-h-wide" width="8" height="9" patternUnits="userSpaceOnUse">
          <line x1="0" y1="4.5" x2="8" y2="4.5" stroke={INK} strokeWidth="1" />
        </pattern>
        <pattern
          id="eng-diag"
          width="7"
          height="7"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(40)"
        >
          <line x1="0" y1="0" x2="0" y2="7" stroke={INK} strokeWidth="1.3" />
        </pattern>
        <pattern
          id="eng-cross"
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(30)"
        >
          <path d="M 0 0 L 0 5 M 0 0 L 5 0" stroke={INK} strokeWidth="1.3" />
        </pattern>
        <pattern
          id="eng-vert"
          width="6"
          height="8"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-8)"
        >
          <line x1="3" y1="0" x2="3" y2="8" stroke={INK} strokeWidth="1.3" />
        </pattern>
        <pattern id="eng-dots" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="2.5" cy="2.5" r="1.1" fill={INK} />
          <circle cx="7.5" cy="7.5" r="1.1" fill={INK} />
        </pattern>
        <linearGradient id="eng-sea-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="0.35" />
          <stop offset="1" stopColor="white" stopOpacity="1" />
        </linearGradient>
        <mask id="eng-sea-mask">
          <rect x="0" y="330" width="1600" height="190" fill="url(#eng-sea-fade)" />
        </mask>
      </defs>

      {/* Sky */}
      <Cloud x={110} y={120} s={1.3} />
      <Cloud x={640} y={70} s={0.9} />
      <Cloud x={1080} y={110} s={1.1} />
      <path
        d="M 430 160 q 7 -6 14 0 q 7 -6 14 0 M 470 140 q 5 -5 10 0 q 5 -5 10 0"
        fill="none"
        stroke={INK}
        strokeWidth="1.2"
      />

      {/* Far range */}
      <path
        d="M 0 330 L 0 302 C 120 292 200 262 300 270 C 380 276 420 240 520 236 C 610 232 660 264 760 272
           C 860 280 900 252 990 257 C 1080 262 1150 290 1250 295 C 1350 300 1450 286 1600 291 L 1600 330 Z"
        fill="url(#eng-h-wide)"
        stroke={INK}
        strokeWidth="1"
      />
      {/* The mountain */}
      <path
        d="M 250 330 C 360 302 470 252 560 214 C 600 198 632 196 662 210 C 722 238 802 282 902 302 C 962 314 1012 322 1062 330 Z"
        fill="url(#eng-diag)"
        stroke={INK}
        strokeWidth="1.3"
      />
      <path
        d="M 662 210 C 722 238 802 282 902 302 C 962 314 1012 322 1062 330 L 760 330 C 720 300 690 260 662 210 Z"
        fill="url(#eng-cross)"
        opacity="0.7"
      />

      {/* Sea */}
      <rect
        x="0"
        y="330"
        width="1600"
        height="190"
        fill="url(#eng-h-fine)"
        mask="url(#eng-sea-mask)"
      />
      <line x1="0" y1="330" x2="1600" y2="330" stroke={INK} strokeWidth="1.2" />
      <path
        d="M 300 372 h 46 M 420 392 h 30 M 520 366 h 60 M 700 384 h 40 M 860 372 h 52 M 960 400 h 34"
        stroke="var(--color-paper)"
        strokeWidth="2.5"
      />

      {/* Sailboat */}
      <g transform="translate(150 392)">
        <path
          d="M -34 0 L 34 0 L 24 12 L -26 12 Z"
          fill="url(#eng-cross)"
          stroke={INK}
          strokeWidth="1.2"
        />
        <line x1="0" y1="0" x2="0" y2="-62" stroke={INK} strokeWidth="1.4" />
        <path d="M 2 -60 L 30 -4 L 2 -4 Z" fill="url(#eng-diag)" stroke={INK} strokeWidth="1.1" />
        <path
          d="M -2 -52 L -24 -4 L -2 -4 Z"
          fill="url(#eng-h-fine)"
          stroke={INK}
          strokeWidth="1.1"
        />
        <path d="M -30 18 h 20 M 6 22 h 26" stroke={INK} strokeWidth="1" />
      </g>

      {/* Headland */}
      <path
        d="M 1040 520 L 1052 474 C 1072 446 1096 424 1118 414 L 1146 362 C 1166 334 1198 320 1240 314
           L 1600 300 L 1600 520 Z"
        fill="url(#eng-diag)"
        stroke={INK}
        strokeWidth="1.4"
      />
      <path
        d="M 1052 474 C 1072 446 1096 424 1118 414 L 1146 362 L 1180 366 L 1160 420 L 1130 470 L 1110 520 L 1040 520 Z"
        fill="url(#eng-vert)"
        stroke={INK}
        strokeWidth="1"
      />
      <path
        d="M 1010 506 c 10 -14 30 -16 42 -4 c 6 8 -2 16 -14 16 h -24 c -8 0 -10 -6 -4 -12 Z
               M 960 512 c 8 -10 22 -10 28 0 c 2 6 -4 8 -12 8 h -12 c -6 0 -8 -4 -4 -8 Z"
        fill="url(#eng-cross)"
        stroke={INK}
        strokeWidth="1"
      />

      {/* Bell tower and houses */}
      <g stroke={INK} strokeWidth="1.2">
        <rect x="1452" y="196" width="34" height="110" fill="var(--color-card)" />
        <rect x="1452" y="196" width="34" height="110" fill="url(#eng-h-wide)" />
        <path
          d="M 1458 226 h 22 v 18 h -22 Z M 1458 262 h 22 v 18 h -22 Z"
          fill="url(#eng-cross)"
        />
        <path d="M 1448 196 h 42 M 1452 186 h 34 v 10 h -34 Z" fill="var(--color-card)" />
        <path d="M 1456 186 C 1456 164 1482 164 1482 186 Z" fill="url(#eng-diag)" />
        <line x1="1469" y1="166" x2="1469" y2="150" />
        <rect x="1340" y="262" width="100" height="44" fill="var(--color-card)" />
        <path d="M 1334 262 L 1390 238 L 1446 262 Z" fill="url(#eng-diag)" />
        <path
          d="M 1356 276 h 12 v 16 h -12 Z M 1384 276 h 12 v 16 h -12 Z M 1412 276 h 12 v 16 h -12 Z"
          fill="url(#eng-cross)"
        />
        <rect x="1498" y="250" width="80" height="56" fill="var(--color-card)" />
        <path d="M 1494 250 L 1538 230 L 1582 250 Z" fill="url(#eng-diag)" />
        <path
          d="M 1512 266 h 12 v 14 h -12 Z M 1548 266 h 12 v 14 h -12 Z"
          fill="url(#eng-cross)"
        />
      </g>

      {/* Cypresses */}
      <Cypress x={1262} y={316} h={120} />
      <Cypress x={1290} y={314} h={150} />
      <Cypress x={1318} y={312} h={104} />
      <Cypress x={1592} y={302} h={128} />
    </svg>
  );
});

/** Shared SVG filter definitions used by theme stylesheets. */
export function ThemeDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden focusable="false">
      {/* Scenic: map line art to cobalt ink on cream paper. */}
      <filter id="atoi-duotone-scenic" colorInterpolationFilters="sRGB">
        <feColorMatrix
          type="matrix"
          values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0"
        />
        <feComponentTransfer>
          <feFuncR type="table" tableValues="0.118 0.965" />
          <feFuncG type="table" tableValues="0.310 0.945" />
          <feFuncB type="table" tableValues="0.612 0.906" />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}
