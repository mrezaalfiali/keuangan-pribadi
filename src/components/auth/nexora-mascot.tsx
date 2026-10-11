"use client";

import { cn } from "@/src/lib/utils";

export type MascotMood = "idle" | "password" | "error" | "pending" | "success";

/**
 * Maskot "koin bertunas" Nexora. Murni SVG + CSS (tanpa library animasi),
 * jadi ringan. Bereaksi lewat `mood`:
 * - `password`: menutup mata dengan kedua tangan saat pengguna mengetik sandi.
 * - `error`: goyang + ekspresi sedih.
 * - `pending`: melompat kecil saat mengirim.
 * - `success`: senyum lebar + kilau.
 */
export function NexoraMascot({ mood = "idle", className }: { mood?: MascotMood; className?: string }) {
  const frown = mood === "error";
  const happy = mood === "success";
  const mouth = frown
    ? "M43 67 Q48 61 53 67"
    : happy
      ? "M42 62 Q48 70 54 62"
      : "M43 63 Q48 68 53 63";

  return (
    <div className={cn("mascot", className)} data-mood={mood} aria-hidden="true">
      <svg viewBox="0 0 96 96" className="mascot-svg h-full w-full" role="presentation">
        <g className="mascot-sprout">
          <path
            d="M48 30 C48 22 48 16 48 11"
            fill="none"
            stroke="var(--accent-strong)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path d="M48 18 C43 18 38 15 37 9 C44 9 48 13 48 18 Z" fill="var(--accent)" />
          <path d="M48 21 C53 21 58 17 59 11 C52 11 48 15 48 21 Z" fill="var(--accent-strong)" />
        </g>

        <circle cx="48" cy="56" r="30" fill="var(--surface2)" stroke="var(--accent)" strokeWidth="2.4" />
        <circle cx="48" cy="56" r="23" fill="none" stroke="var(--accent)" strokeWidth="1.4" opacity="0.35" />

        <circle cx="33" cy="62" r="4" fill="var(--accent)" opacity="0.35" />
        <circle cx="63" cy="62" r="4" fill="var(--accent)" opacity="0.35" />

        <g className="mascot-eyes">
          <circle className="mascot-eye" cx="40" cy="53" r="3.4" fill="var(--ink)" />
          <circle className="mascot-eye" cx="56" cy="53" r="3.4" fill="var(--ink)" />
        </g>
        <g className="mascot-eyes-closed">
          <path d="M36.6 53 Q40 56.2 43.4 53" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
          <path d="M52.6 53 Q56 56.2 59.4 53" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
        </g>

        <path d={mouth} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />

        {happy && (
          <g className="mascot-sparkle" fill="var(--accent-strong)">
            <path d="M76 26 l1.6 4.4 4.4 1.6 -4.4 1.6 -1.6 4.4 -1.6 -4.4 -4.4 -1.6 4.4 -1.6 Z" />
            <path d="M20 32 l1.1 3 3 1.1 -3 1.1 -1.1 3 -1.1 -3 -3 -1.1 3 -1.1 Z" />
          </g>
        )}

        <g className="mascot-paws">
          <circle cx="40" cy="53" r="6.2" fill="var(--surface)" stroke="var(--accent-strong)" strokeWidth="2" />
          <circle cx="56" cy="53" r="6.2" fill="var(--surface)" stroke="var(--accent-strong)" strokeWidth="2" />
        </g>
      </svg>
    </div>
  );
}
