/**
 * A stable colour per collaborator, for cursors and avatars. Hues are spread
 * around the wheel at fixed saturation and lightness so every one reads on both
 * themes, and the same participant is the same colour on every screen.
 *
 * Always `#rrggbb`: the cursor extension accepts nothing else (it drops any
 * other format to transparent), because a colour arrives from other people's
 * browsers and is untrusted - see safeColor.
 */
// Eighteen hues 20 degrees apart: two people share a colour 1 time in 18.
const HUES = Array.from({ length: 18 }, (_, i) => (i * 20 + 5) % 360);
const SATURATION = 0.72;
const LIGHTNESS = 0.5;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(hue: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

export function collaboratorColor(id: string): string {
  return hslToHex(HUES[hash(id) % HUES.length]!, SATURATION, LIGHTNESS);
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A colour from another collaborator's awareness state is attacker-controlled:
 * dropped into a style, `url(...)` would make every viewer fetch an arbitrary
 * address. Only a plain hex colour is used; anything else gets the colour the
 * sender's id would have had anyway.
 */
export function safeColor(color: unknown, id: string): string {
  return typeof color === "string" && HEX.test(color) ? color : collaboratorColor(id);
}
