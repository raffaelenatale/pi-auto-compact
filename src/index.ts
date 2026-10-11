/**
 * pi-auto-compact — context compaction at logical checkpoints.
 *
 * Long sessions have natural checkpoints (a task closed, a phase finished, a
 * change of focus). Compacting there, with instructions about what the next
 * work needs, keeps a better summary than waiting for the context threshold.
 *
 * Entry points:
 * - `/auto-compact [focus]` — the agent writes a compaction prompt for the
 *   described focus (default: continue the most recent work) and runs it
 *   through the `auto_compact` tool. There is no fixed template: what to keep
 *   is always the agent's judgment.
 * - `/auto-compact status` — show configuration and current usage.
 * - Tool `auto_compact` — the model compacts on its own at a checkpoint.
 * - Event `auto-compact:request` — other extensions (e.g. Convoy) request a
 *   compaction: `{ reason?, instructions?, force? }`. Outcomes are emitted on
 *   `auto-compact:result`.
 * - `globalThis.__pi_auto_compact_request(payload, ctx)` — same request for
 *   code that cannot reach the event bus.
 *
 * Compaction runs through pi's native `ctx.compact({ customInstructions })`.
 * That call aborts any active agent run, so the tool never compacts mid-run:
 * it schedules the compaction and runs it on `agent_settled`, when the agent is
 * idle — the same clean state as the native /compact, with no abort error.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REQUEST_EVENT = "auto-compact:request";
export const RESULT_EVENT = "auto-compact:result";

export interface AutoCompactConfig {
	enabled: boolean;
	/** Unforced requests compact only at or above this context usage (%). */
	thresholdPercent: number;
}

export const DEFAULT_CONFIG: AutoCompactConfig = {
	enabled: true,
	thresholdPercent: 60,
};

export interface CompactRequest {
	reason?: string;
	/** Compaction prompt (what to preserve). Without it pi uses its native summary prompt. */
	instructions?: string;
	/** Bypass the threshold. When omitted, non-empty `instructions` imply `force`. */
	force?: boolean;
	source?: string;
}

export type Decision = { action: "compact" | "skip" | "busy"; detail: string; instructions?: string };

/** Pure decision: should this request compact given usage and in-flight state? */
export function decide(
	request: CompactRequest,
	config: AutoCompactConfig,
	usagePercent: number | null,
	compacting: boolean,
): Decision {
	const instructions = request.instructions?.trim() || undefined;
	if (compacting) return { action: "busy", detail: "a compaction is already in flight", instructions };
	if (!config.enabled) return { action: "skip", detail: "auto-compact is disabled", instructions };
	const forced = request.force ?? Boolean(instructions);
	if (!forced) {
		if (usagePercent === null) return { action: "skip", detail: "context usage unknown", instructions };
		if (usagePercent < config.thresholdPercent) {
			return {
				action: "skip",
				detail: `context usage ${usagePercent}% below threshold ${config.thresholdPercent}%`,
				instructions,
			};
		}
	}
	return { action: "compact", detail: "", instructions };
}

export function mergeConfig(base: AutoCompactConfig, overrides: Partial<AutoCompactConfig> | undefined): AutoCompactConfig {
	const merged: AutoCompactConfig = { ...base };
	if (!overrides) return merged;
	if (typeof overrides.enabled === "boolean") merged.enabled = overrides.enabled;
	if (typeof overrides.thresholdPercent === "number" && Number.isFinite(overrides.thresholdPercent)) {
		merged.thresholdPercent = Math.min(100, Math.max(0, overrides.thresholdPercent));
	}
	return merged;
}

/** Reads `PI_AUTO_COMPACT` and `PI_AUTO_COMPACT_THRESHOLD`. */
export function configFromEnv(env: Record<string, string | undefined>): AutoCompactConfig {
	const flag = env.PI_AUTO_COMPACT?.trim().toLowerCase();
	return mergeConfig(DEFAULT_CONFIG, {
		enabled: flag === "0" || flag === "false" ? false : undefined,
		thresholdPercent: env.PI_AUTO_COMPACT_THRESHOLD ? Number(env.PI_AUTO_COMPACT_THRESHOLD) : undefined,
	});
}

export const DEFAULT_FOCUS = "continue working on the most recent work";

/** Message sent to the agent by `/auto-compact [focus]`. */
export function compactPromptRequest(focus?: string): string {
	const target = focus?.trim() || DEFAULT_FOCUS;
	return [
		`Compact your context now, for this focus: "${target}".`,
		"1. Write a compaction prompt in the language of this conversation, optimized for that focus: what the next work needs kept verbatim (e.g. decisions, current state, next steps, open questions, file paths, commits) and what can be dropped. Use your judgment: there is no fixed template.",
		"2. Call the `auto_compact` tool with `force: true` and `instructions` set to that prompt.",
		"Do not do any other work in this turn.",
	].join("\n");
}

export const TOOL_GUIDELINES = [
	"Use `auto_compact` when the user asks to compact, or at a real checkpoint (a task or phase is finished and the next work has a different focus) while context usage is high.",
	"Call `auto_compact` only when the current work is done: the context is compacted right after this turn ends, so close the turn with a short final message and no further work.",
	"In `instructions`, write the compaction prompt yourself: what the next work needs kept verbatim and what can be dropped. Set `force: true` only when the user asked for the compaction.",
];

export default function autoCompactExtension(pi: ExtensionAPI): void {
	const events = (pi as any).events as
		| { on(name: string, handler: (data: any, ctx?: any) => void): any; emit(name: string, data: unknown): void }
		| undefined;
	const config = configFromEnv(process.env);
	let compacting = false;
	/** Scheduled by the tool; started on agent_settled, when no run is active. */
	let pending: { request: CompactRequest; instructions?: string } | null = null;

	const announce = (payload: { status: string; reason?: string; detail?: string }) => {
		try {
			events?.emit(RESULT_EVENT, payload);
		} catch {}
	};

	type Outcome = { status: "started" | "scheduled" | "skip" | "busy" | "error"; detail?: string };

	/** Runs the guards, then compacts now or (deferred) schedules it for agent_settled. */
	const handle = (request: CompactRequest, ctx: any, deferred = false): Outcome => {
		const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		const percent = typeof usage?.percent === "number" ? usage.percent : null;
		const decision = decide(request, config, percent, compacting || pending !== null);
		if (decision.action !== "compact") {
			announce({ status: decision.action === "busy" ? "busy" : "skipped", reason: request.reason, detail: decision.detail });
			return { status: decision.action, detail: decision.detail };
		}
		if (typeof ctx?.compact !== "function") {
			const detail = "context has no compact() — not running inside a pi session";
			announce({ status: "error", reason: request.reason, detail });
			return { status: "error", detail };
		}
		if (deferred) {
			pending = { request, instructions: decision.instructions };
			return { status: "scheduled" };
		}
		return start(request, decision.instructions, ctx);
	};

	const start = (request: CompactRequest, instructions: string | undefined, ctx: any): Outcome => {
		if (typeof ctx?.compact !== "function") {
			const detail = "context has no compact() — not running inside a pi session";
			announce({ status: "error", reason: request.reason, detail });
			return { status: "error", detail };
		}
		const fail = (error: unknown) => {
			compacting = false;
			const detail = String((error as Error)?.message ?? error);
			announce({ status: "error", reason: request.reason, detail });
			// The caller has already returned "started": surface late failures to the user.
			if (ctx?.hasUI) ctx.ui?.notify?.(`auto-compact: compaction failed (${detail})`, "warning");
			return detail;
		};
		compacting = true;
		try {
			ctx.compact({
				customInstructions: instructions,
				onComplete: () => {
					compacting = false;
					announce({ status: "compacted", reason: request.reason });
				},
				onError: fail,
			});
		} catch (error) {
			return { status: "error", detail: fail(error) };
		}
		return { status: "started" };
	};

	events?.on(REQUEST_EVENT, (data: any, ctx: any) => handle(data ?? {}, ctx));
	// The agent is idle here: compacting cannot abort a run.
	(pi as any).on?.("agent_settled", (_event: unknown, ctx: any) => {
		if (!pending) return;
		const { request, instructions } = pending;
		pending = null;
		start(request, instructions, ctx);
	});
	(globalThis as any).__pi_auto_compact_request = (payload: CompactRequest, ctx?: any) => handle(payload ?? {}, ctx ?? null);

	pi.registerCommand("auto-compact", {
		description: "Have the agent write a compaction prompt and compact (`/auto-compact [focus]`), or `/auto-compact status`",
		handler: async (rawArgs: unknown, ctx: any) => {
			const arg = String(rawArgs ?? "").trim();
			if (arg === "status") {
				const usage = ctx?.getContextUsage?.();
				const lines = [
					`auto-compact: ${config.enabled ? "enabled" : "disabled"}`,
					`threshold for the model's own compactions: ${config.thresholdPercent}% (current: ${usage?.percent ?? "?"}%)`,
				];
				ctx?.ui?.notify?.(lines.join("\n"), "info");
				return;
			}
			// The agent writes the compaction prompt for the focus (default: the most
			// recent work) and runs it through the auto_compact tool.
			pi.sendUserMessage(compactPromptRequest(arg), { deliverAs: "followUp" });
			ctx?.ui?.notify?.("auto-compact: the agent is writing the compaction prompt", "info");
		},
	});

	pi.registerTool({
		name: "auto_compact",
		label: "Auto compact",
		description:
			"Compact the conversation context at a logical checkpoint, keeping what `instructions` says the next work needs. " +
			"The compaction runs right after the current turn ends. Skipped below the context-usage threshold unless `force` is true.",
		promptSnippet: "auto_compact: compact the context at a logical checkpoint with focused instructions",
		promptGuidelines: TOOL_GUIDELINES,
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why this is a good checkpoint to compact" },
				instructions: { type: "string", description: "The compaction prompt you wrote: what the next work needs kept verbatim and what can be dropped" },
				force: { type: "boolean", description: "Compact even below the threshold; use only when the user asked" },
			},
			required: ["instructions"],
		} as any,
		async execute(_toolCallId: string, params: CompactRequest, _signal: unknown, _onUpdate: unknown, ctx: any) {
			// Unlike the event API, instructions do not imply force here: the model almost
			// always passes instructions, and that must not bypass the threshold.
			// Deferred: ctx.compact() would abort this very run.
			const outcome = handle(
				{ reason: params?.reason, instructions: params?.instructions, force: params?.force === true, source: "tool" },
				ctx,
				true,
			);
			const text =
				outcome.status === "scheduled"
					? "Compaction scheduled: it runs right after this turn ends. Reply with a short closing message and do no further work."
					: `Compaction not scheduled: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ""}.`;
			return { content: [{ type: "text", text }], details: { status: outcome.status, detail: outcome.detail } };
		},
	});
}

export { autoCompactExtension };
