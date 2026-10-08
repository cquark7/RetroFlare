import type { ReactNode } from "react";

// One stroke grammar for every glyph in the app: 24px grid, 1.8px rounded strokes,
// currentColor so each icon inherits the surrounding text or accent color.
const ICONS = {
  arrowLeft: <path d="M19 12H5m0 0 6-6m-6 6 6 6" />,
  arrowRight: <path d="M5 12h14m0 0-6-6m6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  circle: <circle cx="12" cy="12" r="7.5" />,
  cursor: <path d="M5.5 3.5 18.5 10l-5.6 1.9L10.4 18z" fill="currentColor" strokeWidth={1.4} />,
  download: <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />,
  layers: <>
    <rect x="4" y="7.5" width="12" height="12.5" rx="2.5" />
    <path d="M8 4h9.5A2.5 2.5 0 0 1 20 6.5V16" />
  </>,
  link: <>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4L11.5 6" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1.3-1.2" />
  </>,
  grip: <g fill="currentColor" stroke="none">
    <circle cx="9" cy="6" r="1.45" /><circle cx="15" cy="6" r="1.45" />
    <circle cx="9" cy="12" r="1.45" /><circle cx="15" cy="12" r="1.45" />
    <circle cx="9" cy="18" r="1.45" /><circle cx="15" cy="18" r="1.45" />
  </g>,
  music: <>
    <path d="M9 18V6l10-2v12" />
    <circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" />
  </>,
  pause: <g fill="currentColor" stroke="none">
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" /><rect x="13.9" y="5" width="3.6" height="14" rx="1" />
  </g>,
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />,
  plus: <path d="M12 5v14M5 12h14" />,
  rotateCcw: <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4.2h4.2" />,
  smile: <>
    <path d="M20.5 12.5A8.5 8.5 0 1 1 11.5 3.5" />
    <path d="M8.5 14.2c.9 1.1 2.1 1.7 3.5 1.7s2.6-.6 3.5-1.7" />
    <path d="M9 9.6h.01M15 9.6h.01" />
    <path d="M19 2.5v5M16.5 5h5" />
  </>,
  sparkles: <>
    <path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z" />
    <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </>,
  squareCheck: <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    <path d="m8 12.3 2.6 2.6L16 9.5" />
  </>,
  star: <path d="M12 3.8l2.5 5.1 5.6.8-4.1 4 1 5.6L12 16.5l-5 2.8 1-5.6-4.1-4 5.6-.8z" />,
  trendUp: <>
    <path d="M3.5 16.5 9 11l3.5 3.5 8-8" />
    <path d="M15 6.5h5.5V12" />
  </>,
  upload: <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19.5h14" />,
  users: <>
    <path d="M15.5 19.5v-1.3a3.7 3.7 0 0 0-3.7-3.7H7.2a3.7 3.7 0 0 0-3.7 3.7v1.3" />
    <circle cx="9.5" cy="8" r="3.5" />
    <path d="M20.5 19.5v-1.3a3.7 3.7 0 0 0-2.7-3.6M15.3 4.6a3.5 3.5 0 0 1 0 6.8" />
  </>,
  x: <path d="M18 6 6 18M6 6l12 12" />
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
