/**
 * The handful of icons the controls use, drawn to one grid and one stroke so
 * they read as a set — and in currentColor, so each follows the button it is
 * in, over the camera or on the page. Emoji did this job before and came in
 * whatever colours and sizes each platform's font chose.
 */
const PATHS = {
  settings: <><path d="M19.22 10.39 L21.52 10.76 L21.52 13.24 L19.22 13.61 L18.25 15.96 L19.61 17.85 L17.85 19.61 L15.96 18.25 L13.61 19.22 L13.24 21.52 L10.76 21.52 L10.39 19.22 L8.04 18.25 L6.15 19.61 L4.39 17.85 L5.75 15.96 L4.78 13.61 L2.48 13.24 L2.48 10.76 L4.78 10.39 L5.75 8.04 L4.39 6.15 L6.15 4.39 L8.04 5.75 L10.39 4.78 L10.76 2.48 L13.24 2.48 L13.61 4.78 L15.96 5.75 L17.85 4.39 L19.61 6.15 L18.25 8.04 Z" /><circle cx="12" cy="12" r="3" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  done: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  discard: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="m6.5 7 1 13h9l1-13" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </>
  ),
  lens: (
    <>
      <path d="M10 18.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" />
      <path d="M14 5.5h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-4" />
      <circle cx="12" cy="12" r="3" />
      <path d="m17 21.5-2.5-3 2.5-3" />
      <path d="m7 2.5 2.5 3-2.5 3" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l1.5-2.5h7L17 8h3a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 8z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  paste: (
    <>
      <path d="M8.5 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5h-2" />
      <rect x="8.5" y="2.5" width="7" height="4" rx="1" />
      <path d="M9 11.5h6M9 15h4" />
    </>
  ),
  file: <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7" />,
  text: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" />
    </>
  ),
  flash: <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z" />,
  flashOff: (
    <>
      <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z" />
      <path d="m3 3 18 18" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, filled = false }: { name: IconName; filled?: boolean }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
