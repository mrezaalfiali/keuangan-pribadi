export interface LevelInfo {
  level: number;
  titleKey: string;
  color: string;
  nextThreshold: number | null;
  progress: number; // 0..1 toward next level
}

const LEVELS: Array<{ titleKey: string; color: string; min: number }> = [
  { titleKey: "rank.bronze", color: "#d97706", min: 0 },
  { titleKey: "rank.bronze2", color: "#f59e0b", min: 250 },
  { titleKey: "rank.silver", color: "#94a3b8", min: 600 },
  { titleKey: "rank.silver2", color: "#cbd5e1", min: 1000 },
  { titleKey: "rank.gold", color: "#eab308", min: 1500 },
  { titleKey: "rank.gold2", color: "#facc15", min: 2200 },
  { titleKey: "rank.platinum", color: "#22d3ee", min: 3000 },
  { titleKey: "rank.platinum2", color: "#67e8f9", min: 4200 },
  { titleKey: "rank.obsidian", color: "#a78bfa", min: 5600 },
  { titleKey: "rank.obsidian2", color: "#c4b5fd", min: 7000 },
];

export function getLevelInfo(points: number): LevelInfo {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (points >= LEVELS[i].min) idx = i;
  }
  const current = LEVELS[idx];
  const next = LEVELS[idx + 1] ?? null;
  const base = current.min;
  const ceiling = next ? next.min : base + 1;
  const progress = next ? Math.min(1, (points - base) / (ceiling - base)) : 1;
  return {
    level: idx + 1,
    titleKey: current.titleKey,
    color: current.color,
    nextThreshold: next ? next.min : null,
    progress,
  };
}