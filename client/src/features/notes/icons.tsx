import type { ReactNode } from "react";

/** A small stroke icon set for the notes toolbar: 18px, currentColor, no font. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const icons = {
  bold: (
    <Icon>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </Icon>
  ),
  italic: (
    <Icon>
      <path d="M14 5h-4M14 19h-4M14 5l-4 14" />
    </Icon>
  ),
  strike: (
    <Icon>
      <path d="M5 12h14M16 7.5C15.3 6 13.9 5 12 5c-2.5 0-4 1.3-4 3 0 1.2.8 2.2 2.6 2.9M8 16.5c.7 1.5 2.2 2.5 4.2 2.5 2.6 0 4.3-1.3 4.3-3.2 0-.6-.1-1.1-.4-1.6" />
    </Icon>
  ),
  code: (
    <Icon>
      <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
    </Icon>
  ),
  h1: (
    <Icon>
      <path d="M4 6v12M12 6v12M4 12h8M17 10l2-1.5V18" />
    </Icon>
  ),
  h2: (
    <Icon>
      <path d="M4 6v12M12 6v12M4 12h8M16.5 10.5a2 2 0 0 1 3.5 1.3c0 1.5-3.5 3.2-3.5 6.2H20" />
    </Icon>
  ),
  h3: (
    <Icon>
      <path d="M4 6v12M12 6v12M4 12h8M16.5 9.5h3.2l-2 3a2.2 2.2 0 1 1-1.4 4" />
    </Icon>
  ),
  bullets: (
    <Icon>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" />
    </Icon>
  ),
  numbers: (
    <Icon>
      <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1V9M3.5 14.5a1.3 1.3 0 0 1 2.4.7c0 1-2.4 1.9-2.4 3.3h2.6" />
    </Icon>
  ),
  tasks: (
    <Icon>
      <rect x="3.5" y="4.5" width="6" height="6" rx="1.5" />
      <path d="m5 7.6 1.3 1.3L8.4 6.6M13 7.5h7.5M3.5 16.5h6M13 16.5h7.5" />
    </Icon>
  ),
  quote: (
    <Icon>
      <path d="M7 8.5c-1.7.5-3 2.1-3 4.2V17h5v-5H6.2M17 8.5c-1.7.5-3 2.1-3 4.2V17h5v-5h-2.8" />
    </Icon>
  ),
  codeBlock: (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m10 10-2 2 2 2M14 10l2 2-2 2" />
    </Icon>
  ),
  divider: (
    <Icon>
      <path d="M3 12h18M7 7h10M7 17h10" opacity=".35" />
      <path d="M3 12h18" />
    </Icon>
  ),
  undo: (
    <Icon>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Icon>
  ),
  redo: (
    <Icon>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </Icon>
  ),
  underline: (
    <Icon>
      <path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" />
    </Icon>
  ),
  highlight: (
    <Icon>
      <path d="m9 11-5 5v3h3l5-5M13.5 6.5l4 4M9 11l6.5-6.5a1.5 1.5 0 0 1 2.1 0l1.9 1.9a1.5 1.5 0 0 1 0 2.1L13 15" />
      <path d="M14 20h7" strokeWidth="3" stroke="#f9d65c" />
    </Icon>
  ),
  alignLeft: (
    <Icon>
      <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />
    </Icon>
  ),
  alignCenter: (
    <Icon>
      <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />
    </Icon>
  ),
  alignRight: (
    <Icon>
      <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />
    </Icon>
  ),
  clear: (
    <Icon>
      <path d="M6 5h12M12 5l-3 14M16 15l5 5M21 15l-5 5" />
    </Icon>
  ),
  outline: (
    <Icon>
      <path d="M4 6h4M4 12h4M4 18h4M11 6h9M13 12h7M13 18h7" />
    </Icon>
  ),
  chevron: (
    <Icon>
      <path d="m7 10 5 5 5-5" />
    </Icon>
  ),
};

/** Glyphs for the notes chrome and for upload sections, one per media type.
 *  The document glyph is in the app's own accent, not any product's brand colours. */
export const docIcons = {
  doc: (
    <svg width="26" height="32" viewBox="0 0 26 32" aria-hidden="true" focusable="false">
      <path d="M3 0h14l9 9v20a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3Z" fill="var(--accent)" />
      <path d="M17 0v6a3 3 0 0 0 3 3h6Z" fill="var(--accent-line)" />
      <path d="M6 15h14M6 19.5h14M6 24h9" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  cloud: (
    <Icon>
      <path d="M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.6 1.5A3.8 3.8 0 0 1 17.5 18Z" />
      <path d="m9.5 13.5 2 2 3.5-3.5" />
    </Icon>
  ),
  text: (
    <Icon>
      <path d="M5 6h14M5 10h14M5 14h9M5 18h6" />
    </Icon>
  ),
  image: (
    <Icon>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m20.5 16-4.5-4.5L7 19.5" />
    </Icon>
  ),
  audio: (
    <Icon>
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </Icon>
  ),
  video: (
    <Icon>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="m16 10.5 5-3v9l-5-3" />
    </Icon>
  ),
};
