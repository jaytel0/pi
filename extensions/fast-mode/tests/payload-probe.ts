import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const logPath = process.env.PI_FAST_PROBE_LOG || "/tmp/pi-fast-probe.jsonl";

function safe(value: unknown) {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export default function payloadProbe(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		appendFileSync(
			logPath,
			safe({
				event: "before_provider_request",
				ts: Date.now(),
				provider: ctx.model?.provider,
				model: ctx.model?.id,
				api: ctx.model?.api,
				speed: payload?.speed ?? null,
				service_tier: payload?.service_tier ?? null,
				thinking: payload?.thinking ?? null,
				hasClaudeAgentIdentity:
					Array.isArray(payload?.system) &&
					payload.system.some(
						(block: unknown) =>
							typeof (block as { text?: unknown })?.text === "string" &&
							((block as { text: string }).text.includes("Claude Agent SDK") ||
								(block as { text: string }).text.includes("Claude Code")),
					),
				max_tokens: payload?.max_tokens ?? null,
			}) + "\n",
		);
		return undefined;
	});

	pi.on("after_provider_response", (event, ctx) => {
		appendFileSync(
			logPath,
			safe({
				event: "after_provider_response",
				ts: Date.now(),
				provider: ctx.model?.provider,
				model: ctx.model?.id,
				status: event.status,
			}) + "\n",
		);
	});
}
