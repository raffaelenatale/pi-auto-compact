import test from "node:test";
import assert from "node:assert/strict";
import { decide, mergeConfig, DEFAULT_CONFIG, type CompactRequest, type AutoCompactConfig } from "../src/index.ts";

const cfg: AutoCompactConfig = { ...DEFAULT_CONFIG, thresholdPercent: 60 };

test("decide: below threshold without force skips", () => {
	const d = decide({}, cfg, 30, false);
	assert.equal(d.action, "skip");
	assert.match(d.detail, /below threshold/);
});

test("decide: at or above threshold compacts", () => {
	assert.equal(decide({}, cfg, 60, false).action, "compact");
	assert.equal(decide({}, cfg, 95, false).action, "compact");
});

test("decide: explicit instructions force compaction below threshold", () => {
	const d = decide({ instructions: "keep the contract" }, cfg, 10, false);
	assert.equal(d.action, "compact");
	assert.match(d.instructions, /keep the contract/);
	assert.match(d.instructions, /Preserve/); // defaults merged in
});

test("decide: force flag bypasses threshold and unknown usage", () => {
	assert.equal(decide({ force: true }, cfg, null, false).action, "compact");
	assert.equal(decide({}, cfg, null, false).action, "skip");
});

test("decide: busy while a compaction is in flight", () => {
	assert.equal(decide({ force: true }, cfg, 90, true).action, "busy");
});

test("decide: disabled config always skips", () => {
	assert.equal(decide({ force: true }, { ...cfg, enabled: false }, 90, false).action, "skip");
});

test("mergeConfig: clamps and ignores junk", () => {
	const merged = mergeConfig(DEFAULT_CONFIG, { thresholdPercent: 500, enabled: false, defaultInstructions: "  " });
	assert.equal(merged.thresholdPercent, 100);
	assert.equal(merged.enabled, false);
	assert.equal(merged.defaultInstructions, DEFAULT_CONFIG.defaultInstructions);
});
