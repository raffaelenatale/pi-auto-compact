import test from "node:test";
import assert from "node:assert/strict";
import autoCompactExtension, { DEFAULT_FOCUS, REQUEST_EVENT, RESULT_EVENT, TOOL_GUIDELINES } from "../src/index.ts";

/** Minimal fake of the pi extension API and of an extension context. */
function setup(usagePercent: number | null = 80) {
	const commands: Record<string, any> = {};
	const tools: Record<string, any> = {};
	const handlers: Record<string, (data: any, ctx?: any) => any> = {};
	const sent: Array<[string, any]> = [];
	const emitted: Array<[string, any]> = [];
	const compactions: any[] = [];
	const notices: string[] = [];
	const pi = {
		registerCommand: (name: string, options: any) => (commands[name] = options),
		registerTool: (tool: any) => (tools[tool.name] = tool),
		sendUserMessage: (text: string, options: any) => sent.push([text, options]),
		events: {
			on: (name: string, handler: any) => (handlers[name] = handler),
			emit: (name: string, data: any) => emitted.push([name, data]),
		},
	};
	const ctx = {
		hasUI: true,
		ui: { notify: (text: string) => notices.push(text) },
		getContextUsage: () => (usagePercent === null ? undefined : { percent: usagePercent }),
		compact: (options: any) => compactions.push(options),
	};
	autoCompactExtension(pi as any);
	return { commands, tools, handlers, sent, emitted, compactions, notices, ctx };
}

test("/auto-compact <focus> asks the agent to write the prompt and call the tool", async () => {
	const s = setup();
	await s.commands["auto-compact"].handler("task 3: fix the chart bug", s.ctx);
	assert.equal(s.compactions.length, 0, "the command itself does not compact");
	assert.equal(s.sent.length, 1);
	const [text, options] = s.sent[0];
	assert.deepEqual(options, { deliverAs: "followUp" });
	assert.match(text, /task 3: fix the chart bug/);
	assert.match(text, /auto_compact/);
	assert.match(text, /force: true/);
});

test("/auto-compact with no focus targets the most recent work", async () => {
	const s = setup();
	await s.commands["auto-compact"].handler("", s.ctx);
	assert.equal(s.compactions.length, 0);
	assert.match(s.sent[0][0], new RegExp(DEFAULT_FOCUS));
});

test("/auto-compact status only reports", async () => {
	const s = setup(42);
	await s.commands["auto-compact"].handler("status", s.ctx);
	assert.equal(s.sent.length, 0);
	assert.equal(s.compactions.length, 0);
	assert.match(s.notices[0], /enabled/);
	assert.match(s.notices[0], /42%/);
});

test("tool: requires instructions and ships prompt guidelines", () => {
	const { tools } = setup();
	const tool = tools.auto_compact;
	assert.deepEqual(tool.parameters.required, ["instructions"]);
	assert.deepEqual(tool.promptGuidelines, TOOL_GUIDELINES);
	assert.ok(tool.promptSnippet);
});

test("tool: passes the agent's prompt verbatim to pi's compaction", async () => {
	const s = setup(80);
	const result = await s.tools.auto_compact.execute("id", { instructions: "keep the task list" }, null, null, s.ctx);
	assert.equal(result.details.status, "started");
	assert.equal(s.compactions[0].customInstructions, "keep the task list");
});

test("tool: below threshold without force does not compact", async () => {
	const s = setup(20);
	const result = await s.tools.auto_compact.execute("id", { instructions: "keep the task list" }, null, null, s.ctx);
	assert.equal(result.details.status, "skip");
	assert.equal(s.compactions.length, 0);
});

test("tool: force compacts below threshold", async () => {
	const s = setup(20);
	const result = await s.tools.auto_compact.execute("id", { instructions: "keep it", force: true }, null, null, s.ctx);
	assert.equal(result.details.status, "started");
});

test("tool: a second request while compacting is busy; completion frees it", async () => {
	const s = setup(80);
	await s.tools.auto_compact.execute("id", { instructions: "a" }, null, null, s.ctx);
	const second = await s.tools.auto_compact.execute("id", { instructions: "b" }, null, null, s.ctx);
	assert.equal(second.details.status, "busy");
	s.compactions[0].onComplete();
	assert.deepEqual(s.emitted.at(-1), [RESULT_EVENT, { status: "compacted", reason: undefined }]);
	const third = await s.tools.auto_compact.execute("id", { instructions: "c" }, null, null, s.ctx);
	assert.equal(third.details.status, "started");
});

test("late compaction errors are announced and shown to the user", async () => {
	const s = setup(80);
	await s.tools.auto_compact.execute("id", { instructions: "a", reason: "phase done" }, null, null, s.ctx);
	s.compactions[0].onError(new Error("Nothing to compact"));
	assert.deepEqual(s.emitted.at(-1), [RESULT_EVENT, { status: "error", reason: "phase done", detail: "Nothing to compact" }]);
	assert.match(s.notices.at(-1)!, /Nothing to compact/);
});

test("tool: without a pi context it reports an error", async () => {
	const s = setup();
	const result = await s.tools.auto_compact.execute("id", { instructions: "a", force: true }, null, null, {});
	assert.equal(result.details.status, "error");
});

test("event API: unforced request without instructions follows the threshold", () => {
	const low = setup(10);
	low.handlers[REQUEST_EVENT]({ reason: "phase" }, low.ctx);
	assert.equal(low.compactions.length, 0);
	assert.equal(low.emitted.at(-1)![1].status, "skipped");

	const high = setup(90);
	high.handlers[REQUEST_EVENT]({ reason: "phase" }, high.ctx);
	assert.equal(high.compactions.length, 1);
	assert.equal(high.compactions[0].customInstructions, undefined, "pi's native summary prompt is used");
});
