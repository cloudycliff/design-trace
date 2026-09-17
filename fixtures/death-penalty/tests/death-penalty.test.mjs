import assert from "node:assert/strict";
import test from "node:test";
import { deathPenalty } from "../src/death-penalty.mjs";
import config from "../config/death-penalty.json" with { type: "json" };

for (const gold of [0, 1, 19, 100, 101]) {
  for (const difficulty of ["normal", "hard"]) {
    test(`${difficulty} deducts its configured penalty rounded down from ${gold} gold`, () => {
      const expected = Math.floor((gold * config[difficulty].penalty_bps) / 10_000);
      assert.equal(deathPenalty(gold, difficulty), expected);
    });
  }
}
