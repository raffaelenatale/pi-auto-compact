/**
 * pi-auto-compact — compaction on demand at logical checkpoints.
 *
 * Any long session with logical checkpoints (phase boundaries, milestone gates)
 * benefits from a focused compaction instead of waiting for the context
 * threshold. This extension exposes one small contract:
 *
 * - `/auto-compact [instructions]` — compact now (skips the threshold with
 *   `force` or when explicit instructions are given).
 * - Custom pi event `auto-compact:request` — other extensions (e.g. Convoy)
 *   request a compaction at a logical point: `{ reason, instructions?, force? }`.
 *   Results are announced on `auto-compact:result`
 *   `{ status: "compacted" | "skipped" | "busy" | "error", reason, detail? }`.
 * - `globalThis.__pi_auto_compact_request(payload)` — same request, callable
 *   from tool code that cannot reach the event bus.
 *
 * Compaction uses pi's native `ctx.compact({ customInstructions })`; the
 * summary keeps what the instructions say to keep (contract, state, decisions).
 * Requests below `thresholdPercent` of context usage are skipped unless forced,
 * and a request while a compaction is in flight returns "busy" without retry.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REQUEST_EVENT = "auto-compact:request";
export const RESULT_EVENT = "auto-compact:result";

export interface AutoCompactConfig {
	enabled: boolean;
	/** Compact only when context usage is at or above this percentage. */
	thresholdPercent: number;
	/** Instructions merged into every compaction unless overridden per request. */
	defaultInstructions: string;
}

export const DEFAULT_CONFIG: AutoCompactConfig = {
	enabled: true,
	thresholdPercent: 60,
	defaultInstructions: [
		"Preserve, verbatim where possible:",
		"- the active contract/plan and its frozen decisions;",
		"- current run/checkpoint state and the next concrete steps;",
		"- open human questions and their answers;",
		"- key evidence paths (receipts, logs, reports) and head commits.",
		"Drop exploratory detours and verbose tool output; keep outcomes and file paths.",
	].join("\n"),
};

export interface CompactRequest {
	reason?: string;
	instructions?: string;
	force?: boolean;
	source?: string;
}

export type CompactDecision =
	| { status: "compacted" }
	| { status: "skipped"; detail: string }
	| { status: "busy" }
	| { status: "error"; detail: string };

/** Pure decision: should this request compact given usage and in-flight state? */
export function decide(
	request: CompactRequest,
	config: AutoCompactConfig,
	usagePercent: number | null,
	compacting: boolean,
): { action: "compact" | "skip" | "busy"; detail: string; instructions: string } {
	const instructions = request.instructions?.trim()
		? `${request.instructions.trim()}\n\n${config.defaultInstructions}`
		: config.defaultInstructions;
	if (compacting) return { action: "busy", detail: "a compaction is already in flight", instructions };
	if (!config.enabled) return { action: "skip", detail: "auto-compact is disabled", instructions };
	const forced = Boolean(request.force) || Boolean(request.instructions?.trim());
	if (!forced) {
		if (usagePercent === null) {
			return { action: "skip", detail: "context usage unknown", instructions };
		}
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
	if (!overrides) return { ...base };
	const merged: AutoCompactConfig = { ...base };
	if (typeof overrides.enabled === "boolean") merged.enabled = overrides.enabled;
	if (typeof overrides.thresholdPercent === "number" && Number.isFinite(overrides.thresholdPercent)) {
		merged.thresholdPercent = Math.min(100, Math.max(0, overrides.thresholdPercent));
	}
	if (typeof overrides.defaultInstructions === "string" && overrides.defaultInstructions.trim()) {
		merged.defaultInstructions = overrides.defaultInstructions;
	}
	return merged;
}

export default function autoCompactExtension(pi: ExtensionAPI): void {
	const events = (pi as any).events as
		| { on(name: string, handler: (data: any, ctx?: any) => void): any; emit(name: string, data: unknown): void }
		| undefined;
	const env = process.env;
	let config = mergeConfig(DEFAULT_CONFIG, {
		enabled: env.PI_AUTO_COMPACT === "0" || env.PI_AUTO_COMPACT === "false" ? false : undefined,
		thresholdPercent: env.PI_AUTO_COMPACT_THRESHOLD ? Number(env.PI_AUTO_COMPACT_THRESHOLD) : undefined,
	});
	let compacting = false;

	const result = (payload: { status: string; reason?: string; detail?: string }) => {
		try {
			events?.emit(RESULT_EVENT, payload);
		} catch {}
	};

	const handle = (request: CompactRequest, ctx: any): { status: string; detail?: string } => {
		const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
		const percent = usage && typeof usage.percent === "number" ? usage.percent : null;
		const decision = decide(request ?? {}, config, percent, compacting);
		if (decision.action !== "compact") {
			result({ status: decision.action === "busy" ? "busy" : "skipped", reason: request?.reason, detail: decision.detail });
			return { status: decision.action, detail: decision.detail };
		}
		compacting = true;
		try {
			ctx.compact?.({
				customInstructions: decision.instructions,
				onComplete: () => {
					compacting = false;
					result({ status: "compacted", reason: request?.reason });
				},
				onError: (error: Error) => {
					compacting = false;
					result({ status: "error", reason: request?.reason, detail: String(error?.message ?? error) });
				},
			});
		} catch (error: any) {
			compacting = false;
			const detail = String(error?.message ?? error);
			result({ status: "error", reason: request?.reason, detail });
			return { status: "error", detail };
		}
		return { status: "compacted" };
	};

	events?.on(REQUEST_EVENT, (data: any, ctx: any) => handle(data ?? {}, ctx));
	(globalThis as any).__pi_auto_compact_request = (payload: CompactRequest, ctx?: any) =>
		handle(payload ?? {}, ctx ?? null);

	pi.registerCommand("auto-compact", {
		description: "Compact context now, or show auto-compact status (`/auto-compact status`)",
		handler: async (rawArgs: unknown, ctx: any) => {
			const arg = String(rawArgs ?? "").trim();
			if (arg === "status") {
				const usage = ctx?.getContextUsage?.();
				const lines = [
					`auto-compact: ${config.enabled ? "enabled" : "disabled"}`,
					`threshold: ${config.thresholdPercent}% (current: ${usage?.percent ?? "?"}%)`,
					"instructions template:",
					config.defaultInstructions,
				];
				ctx?.ui?.notify?.(lines.join("\n"), "info");
				return;
			}
			const outcome = handle(
				{ reason: arg ? "slash-command" : "slash-command", instructions: arg || undefined, force: true, source: "user" },
				ctx,
			);
			if (ctx?.hasUI) {
				ctx.ui.notify?.(
					outcome.status === "compacted"
						? "auto-compact: compaction started"
						: `auto-compact: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ""}`,
					outcome.status === "compacted" ? "info" : "warning",
				);
			}
		},
	});
}

export { autoCompactExtension };
