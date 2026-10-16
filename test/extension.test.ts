import test from "node:test";
import assert from "node:assert/strict";
import autoCompactExtension, { configFromEnv, thinkingForCompaction, DEFAULT_FOCUS, MAX_AUTO_RESUMES, REQUEST_EVENT, RESULT_EVENT, TOOL_GUIDELINES } from "../src/index.ts";

/**
 * Minimal fake of the pi extension API and of an extension context. Like pi's
 * real event bus, `events` handlers receive only the payload, never a context.
 */
function setup(usagePercent: number | null = 80, { idle = true, started = true, thinking = "high" as string } = {}) {
	const levels: string[] = [thinking];
	const commands: Record<string, any> = {};
	const tools: Record<string, any> = {};
	const handlers: Record<string, (data: any) => any> = {};
	const piHandlers: Record<string, (event: any, ctx?: any) => any> = {};
	const sent: Array<[string, any]> = [];
	const messages: Array<[any, any]> = [];
	const emitted: Array<[string, any]> = [];
	const compactions: any[] = [];
	const notices: string[] = [];
	const pi = {
		registerCommand: (name: string, options: any) => (commands[name] = options),
		registerTool: (tool: any) => (tools[tool.name] = tool),
		sendUserMessage: (text: string, options: any) => sent.push([text, options]),
		sendMessage: (message: any, options: any) => messages.push([message, options]),
		on: (name: string, handler: any) => (piHandlers[name] = handler),
		getThinkingLevel: () => levels[levels.length - 1],
		setThinkingLevel: (level: string) => levels.push(level),
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
		idle,
		isIdle: () => ctx.idle,
	};
	autoCompactExtension(pi as any);
	if (started) piHandlers.session_start?.({ type: "session_start" }, ctx);
	const settle = () => {
		ctx.idle = true;
		piHandlers.agent_settled?.({ type: "agent_settled", aborted: false }, ctx);
	};
	const request = (data: any) => handlers[REQUEST_EVENT](data);
	const userInput = (source = "interactive") => piHandlers.input?.({ type: "input", text: "hi", source }, ctx);
	return { levels, commands, tools, handlers, sent, messages, emitted, compactions, notices, ctx, settle, request, userInput };
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

test("tool: schedules the agent's prompt and compacts only when the agent settles", async () => {
	const s = setup(80);
	const result = await s.tools.auto_compact.execute("id", { instructions: "keep the task list" }, null, null, s.ctx);
	assert.equal(result.details.status, "scheduled");
	assert.equal(s.compactions.length, 0, "no compaction mid-run: it would abort the turn");
	s.settle();
	assert.equal(s.compactions.length, 1);
	assert.equal(s.compactions[0].customInstructions, "keep the task list");
	s.settle();
	assert.equal(s.compactions.length, 1, "a schedule runs once");
});

test("agent_settled without a scheduled compaction does nothing", () => {
	const s = setup(80);
	s.settle();
	assert.equal(s.compactions.length, 0);
});

test("tool: below threshold without force does not schedule", async () => {
	const s = setup(20);
	const result = await s.tools.auto_compact.execute("id", { instructions: "keep the task list" }, null, null, s.ctx);
	assert.equal(result.details.status, "skip");
	s.settle();
	assert.equal(s.compactions.length, 0);
});

test("tool: force schedules below threshold", async () => {
	const s = setup(20);
	const result = await s.tools.auto_compact.execute("id", { instructions: "keep it", force: true }, null, null, s.ctx);
	assert.equal(result.details.status, "scheduled");
});

test("tool: busy while scheduled or compacting; completion frees it", async () => {
	const s = setup(80);
	await s.tools.auto_compact.execute("id", { instructions: "a" }, null, null, s.ctx);
	const whileScheduled = await s.tools.auto_compact.execute("id", { instructions: "b" }, null, null, s.ctx);
	assert.equal(whileScheduled.details.status, "busy");
	s.settle();
	const whileCompacting = await s.tools.auto_compact.execute("id", { instructions: "c" }, null, null, s.ctx);
	assert.equal(whileCompacting.details.status, "busy");
	s.compactions[0].onComplete();
	assert.deepEqual(s.emitted.at(-1), [RESULT_EVENT, { status: "compacted", reason: undefined }]);
	const after = await s.tools.auto_compact.execute("id", { instructions: "d" }, null, null, s.ctx);
	assert.equal(after.details.status, "scheduled");
});

test("late compaction errors are announced and shown to the user", async () => {
	const s = setup(80);
	await s.tools.auto_compact.execute("id", { instructions: "a", reason: "phase done" }, null, null, s.ctx);
	s.settle();
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
	low.request({ reason: "phase" });
	assert.equal(low.compactions.length, 0);
	assert.equal(low.emitted.at(-1)![1].status, "skipped");

	const high = setup(90);
	high.request({ reason: "phase" });
	assert.equal(high.compactions.length, 1, "the bus carries no context: the last lifecycle context is used");
	assert.equal(high.compactions[0].customInstructions, undefined, "pi's native summary prompt is used");
});

test("event API: before any lifecycle context it reports an error instead of throwing", () => {
	const s = setup(90, { started: false });
	assert.equal(s.request({ reason: "phase", instructions: "keep it" }).status, "error");
	assert.equal(s.emitted.at(-1)![1].status, "error");
});

test("event API: while the agent is busy the request waits for agent_settled", () => {
	const s = setup(90, { idle: false });
	assert.equal(s.request({ reason: "phase", instructions: "keep the plan" }).status, "scheduled");
	assert.deepEqual(s.emitted.at(-1), [RESULT_EVENT, { status: "scheduled", reason: "phase" }]);
	assert.equal(s.compactions.length, 0, "compacting now would abort the active run");
	s.settle();
	assert.equal(s.compactions.length, 1);
	assert.equal(s.compactions[0].customInstructions, "keep the plan");
});

test("resume: after compacting, the agent restarts on the resume message", () => {
	const s = setup(90);
	s.request({ reason: "phase", instructions: "keep the plan", resume: "Continue with task 4." });
	assert.equal(s.messages.length, 0, "nothing is sent before the compaction completes");
	s.compactions[0].onComplete();
	assert.equal(s.messages.length, 1);
	const [message, options] = s.messages[0];
	assert.equal(message.content, "Continue with task 4.");
	assert.deepEqual(options, { triggerTurn: true });
	assert.deepEqual(s.emitted.at(-1), [RESULT_EVENT, { status: "compacted", reason: "phase", resumed: true }]);
});

test("resume: not sent when the compaction fails", () => {
	const s = setup(90);
	s.request({ instructions: "a", resume: "go on" });
	s.compactions[0].onError(new Error("boom"));
	assert.equal(s.messages.length, 0);
});

test("resume: the tool passes it through the deferred compaction", async () => {
	const s = setup(80);
	await s.tools.auto_compact.execute("id", { instructions: "a", resume: "next step" }, null, null, s.ctx);
	s.settle();
	s.compactions[0].onComplete();
	assert.equal(s.messages[0][0].content, "next step");
});

test("resume: bounded without user input, re-armed by a user message", () => {
	const s = setup(90);
	const cycle = () => {
		s.request({ instructions: "a", resume: "go on" });
		s.compactions.at(-1).onComplete();
	};
	for (let i = 0; i < MAX_AUTO_RESUMES; i++) cycle();
	assert.equal(s.messages.length, MAX_AUTO_RESUMES);
	cycle();
	assert.equal(s.messages.length, MAX_AUTO_RESUMES, "loop guard");
	assert.equal(s.emitted.at(-1)![1].resumed, false);
	assert.match(s.notices.at(-1)!, /resume skipped/);
	s.userInput("extension");
	cycle();
	assert.equal(s.messages.length, MAX_AUTO_RESUMES, "extension input does not re-arm");
	s.userInput();
	cycle();
	assert.equal(s.messages.length, MAX_AUTO_RESUMES + 1);
});

test("thinkingForCompaction caps only levels above the cap", () => {
	assert.equal(thinkingForCompaction("high", "low"), "low");
	assert.equal(thinkingForCompaction("max", "low"), "low");
	assert.equal(thinkingForCompaction("low", "low"), null);
	assert.equal(thinkingForCompaction("off", "low"), null);
	assert.equal(thinkingForCompaction("high", null), null);
	assert.equal(thinkingForCompaction(undefined, "low"), null);
});

test("config: PI_AUTO_COMPACT_THINKING sets the cap, 'keep' disables it, junk is ignored", () => {
	assert.equal(configFromEnv({}).compactThinking, "low");
	assert.equal(configFromEnv({ PI_AUTO_COMPACT_THINKING: "Medium" }).compactThinking, "medium");
	assert.equal(configFromEnv({ PI_AUTO_COMPACT_THINKING: "keep" }).compactThinking, null);
	assert.equal(configFromEnv({ PI_AUTO_COMPACT_THINKING: "bogus" }).compactThinking, "low");
});

test("compaction lowers the thinking level and restores it on completion", () => {
	const s = setup(80, { thinking: "high" });
	s.request({ reason: "r", force: true });
	assert.equal(s.compactions.length, 1);
	assert.deepEqual(s.levels, ["high", "low"], "capped while the summary is generated");
	s.compactions[0].onComplete({});
	assert.deepEqual(s.levels, ["high", "low", "high"], "restored afterwards");
});

test("compaction restores the thinking level on error", () => {
	const s = setup(80, { thinking: "high" });
	s.request({ reason: "r", force: true });
	s.compactions[0].onError(new Error("boom"));
	assert.deepEqual(s.levels, ["high", "low", "high"]);
});

test("compaction leaves a level that is already low untouched", () => {
	const s = setup(80, { thinking: "low" });
	s.request({ reason: "r", force: true });
	s.compactions[0].onComplete({});
	assert.deepEqual(s.levels, ["low"]);
});

test("compaction does not restore over a level the user changed meanwhile", () => {
	const s = setup(80, { thinking: "high" });
	s.request({ reason: "r", force: true });
	s.levels.push("medium");
	s.compactions[0].onComplete({});
	assert.deepEqual(s.levels, ["high", "low", "medium"]);
});
