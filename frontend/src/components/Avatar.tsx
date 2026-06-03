/**
 * Deterministic avatar styling — given a stable seed (user id or username),
 * produce a color and 1–2 character initials. Used everywhere we'd otherwise
 * need an uploaded image: chat author tag, members panel, profile page.
 */
import React from "react";

// Discord-ish saturated palette, dark-background-friendly.
const PALETTE = [
  "#5865f2", "#3ba55d", "#faa61a", "#ed4245", "#eb459e",
  "#9b59b6", "#1abc9c", "#e67e22", "#71368a", "#206694",
  "#11806a", "#c27c0e", "#992d22", "#979c9f",
];

export function avatarColor(seed: string): string {
  // Simple FNV-ish hash → palette index. Same seed → same color.
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

export function avatarInitials(name: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  // For single token (username or uuid prefix), take 1-2 leading letters.
  return name.slice(0, 2).toUpperCase();
}

interface AvatarProps {
  seed: string;
  name: string;
  size?: number;
  className?: string;
}

/**
 * Round colored avatar with initials. Works as a drop-in image substitute.
 */
export default function Avatar({ seed, name, size = 32, className = "" }: AvatarProps) {
  const bg = avatarColor(seed);
  const text = avatarInitials(name);
  return React.createElement(
    "div",
    {
      className: `inline-flex items-center justify-center rounded-full text-white font-medium select-none ${className}`,
      style: {
        backgroundColor: bg,
        width: size,
        height: size,
        fontSize: Math.max(10, Math.floor(size * 0.4)),
      },
      "aria-label": name,
    },
    text
  );
}
