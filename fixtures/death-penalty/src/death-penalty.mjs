import config from "../config/death-penalty.json" with { type: "json" };

export function deathPenalty(gold, difficulty) {
  const rule = config[difficulty];
  if (!rule) throw new Error(`Unknown difficulty: ${difficulty}`);
  return Math.floor((gold * rule.penalty_bps) / 10_000);
}
