/**
 * Example third-party extension (e.g. Convoy) that requests compactions through
 * pi-auto-compact's event API, for manual testing:
 *
 *   pi -ne -e ./src/index.ts -e ./examples/third-party.ts
 *
 * - `/ac-demo [resume]` — request while the agent is idle: compacts now, then
 *   the agent restarts on `resume` (default below).
 * - tool `ac_demo_checkpoint` — the model calls it mid-run: the request is
 *   scheduled and runs once the turn ends, then the agent resumes.
 * Every `auto-compact:result` is shown as a notification.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_RESUME = "Context compacted by the demo extension. Say which step you are on, then continue the work.";

export default function thirdParty(pi: ExtensionAPI): void {
	let notify: ((text: string) => void) | undefined;
	pi.on("session_start", (_event, ctx: any) => {
		notify = (text) => ctx?.ui?.notify?.(text, "info");
	});
	pi.events.on("auto-compact:result", (result: any) =>
		notify?.(`demo ← auto-compact:result ${JSON.stringify(result)}`),
	);

	pi.registerCommand("ac-demo", {
		description: "Demo: request a compaction via the event API (idle path), then resume",
		handler: async (args: unknown) => {
			pi.events.emit("auto-compact:request", {
				reason: "demo idle request",
				instructions: "Keep the user's goal, the current step and the decisions; drop tool output.",
				resume: String(args ?? "").trim() || DEFAULT_RESUME,
			});
		},
	});

	pi.registerTool({
		name: "ac_demo_checkpoint",
		label: "Demo checkpoint",
		description:
			"Demo of a third-party extension: requests a compaction through the event API while the agent is running. " +
			"Call it only when the user asks for the demo checkpoint.",
		parameters: { type: "object", properties: { next: { type: "string", description: "Next step to resume with" } } } as any,
		async execute(_id: string, params: any) {
			pi.events.emit("auto-compact:request", {
				reason: "demo mid-run request",
				instructions: "Keep the user's goal, the current step and the decisions; drop tool output.",
				resume: params?.next?.trim() || DEFAULT_RESUME,
			});
			return { content: [{ type: "text", text: "Checkpoint requested." }], details: undefined };
		},
	} as any);
}
