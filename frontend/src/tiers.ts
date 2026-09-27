import type { CSSProperties } from "react";
import type { Tier } from "./types";

export const TIER_ORDER: readonly Tier[] = ["reach", "target", "safety"];

export const TIER_LABEL: Record<Tier, string> = {
  reach: "Reach",
  target: "Target",
  safety: "Safety",
};

const TIER_COLOR: Record<Tier, string> = {
  reach: "var(--orange)",
  target: "var(--green)",
  safety: "var(--blue)",
};

export function tierVar(t: Tier): CSSProperties {
  return { ["--tier" as string]: TIER_COLOR[t] } as CSSProperties;
}
