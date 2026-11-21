// Sharding (spec 07 §5.5): units packed in path order into shards of at most 50,000 estimated tokens
// of unit text; a unit larger than a shard is a shard alone. One session per (shard, lens).

import { estimateTokens } from "./units/inventory.ts";
import type { Unit } from "./units/inventory.ts";

export const SHARD_TOKENS = 50_000;

export interface Shard {
  readonly index: number;
  readonly units: readonly Unit[];
  readonly tokens: number;
}

/** Packs `units` (already in path order) into shards. */
export function packShards(units: readonly Unit[], budget: number = SHARD_TOKENS): Shard[] {
  if (!Number.isInteger(budget) || budget <= 0) throw new TypeError("a shard budget must be a positive integer");
  const shards: Array<{ units: Unit[]; tokens: number }> = [];
  for (const unit of units) {
    const tokens = estimateTokens(unit.text);
    const last = shards[shards.length - 1];
    if (last !== undefined && last.tokens + tokens <= budget) {
      last.units.push(unit);
      last.tokens += tokens;
    } else shards.push({ units: [unit], tokens });
  }
  return shards.map((shard, index) => Object.freeze({ index, units: Object.freeze(shard.units), tokens: shard.tokens }));
}
