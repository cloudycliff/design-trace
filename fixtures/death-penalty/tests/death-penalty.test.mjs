import assert from "node:assert/strict";
import test from "node:test";
import { deathPenalty } from "../src/death-penalty.mjs";

for (const gold of [0, 1, 19, 100, 101]) {
  test(`baseline deducts 10% rounded down from ${gold} gold`, () => {
    const expected = Math.floor((gold * 1000) / 10_000);
    assert.equal(deathPenalty(gold, "normal"), expected);
    assert.equal(deathPenalty(gold, "hard"), expected);
  });
}
