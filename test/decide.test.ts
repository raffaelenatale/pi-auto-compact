import test from "node:test";
import assert from "node:assert/strict";
import { configFromEnv, decide, mergeConfig, DEFAULT_CONFIG, type AutoCompactConfig } from "../src/index.ts";

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

test("decide: instructions are passed through as-is, with no fixed template", () => {
	assert.equal(decide({ instructions: "  keep the contract  " }, cfg, 90, false).instructions, "keep the contract");
	assert.equal(decide({}, cfg, 90, false).instructions, undefined);
	assert.equal(decide({ instructions: "   " }, cfg, 90, false).instructions, undefined);
});

test("decide: instructions imply force when force is omitted", () => {
	assert.equal(decide({ instructions: "keep the contract" }, cfg, 10, false).action, "compact");
});

test("decide: explicit force=false keeps the threshold even with instructions", () => {
	assert.equal(decide({ instructions: "keep the contract", force: false }, cfg, 10, false).action, "skip");
	assert.equal(decide({ instructions: "keep the contract", force: false }, cfg, 70, false).action, "compact");
});

test("decide: force bypasses threshold and unknown usage", () => {
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
	assert.equal(mergeConfig(DEFAULT_CONFIG, { thresholdPercent: 500 }).thresholdPercent, 100);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { thresholdPercent: Number.NaN }).thresholdPercent, 60);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { enabled: false }).enabled, false);
});

test("configFromEnv: reads the switch and the threshold", () => {
	assert.equal(configFromEnv({}).enabled, true);
	assert.equal(configFromEnv({ PI_AUTO_COMPACT: "0" }).enabled, false);
	assert.equal(configFromEnv({ PI_AUTO_COMPACT: "FALSE" }).enabled, false);
	assert.equal(configFromEnv({ PI_AUTO_COMPACT_THRESHOLD: "75" }).thresholdPercent, 75);
	assert.equal(configFromEnv({ PI_AUTO_COMPACT_THRESHOLD: "abc" }).thresholdPercent, 60);
});
