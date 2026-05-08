import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type FastModeState = {
	enabled: boolean;
};

type FastModeStats = {
	injectedCount: number;
	lastInjectedAt?: number;
	lastInjectedModel?: string;
	lastInjectedProvider?: string;
	lastInjectedApi?: string;
};

const FAST_SERVICE_TIER = "priority";
const SUPPORTED_MODEL_RE = /^gpt-5\.(4|5)(?:$|-)/i;
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-codex"]);

const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const statePath = join(configDir, "fast-mode.json");

function readStateFile(path: string): FastModeState | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FastModeState>;
		return { enabled: parsed.enabled === true };
	} catch {
		return undefined;
	}
}

function loadState(): FastModeState {
	return readStateFile(statePath) ?? { enabled: false };
}

function saveState(state: FastModeState): void {
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, JSON.stringify(state, null, "\t") + "\n", "utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelIdFromPayload(payload: unknown): string | undefined {
	if (!isObject(payload)) return undefined;
	return typeof payload.model === "string" ? payload.model : undefined;
}

function supportsFastMode(model: ExtensionContext["model"] | undefined, payload?: unknown): boolean {
	const modelId = model?.id ?? modelIdFromPayload(payload) ?? "";
	if (!SUPPORTED_MODEL_RE.test(modelId)) return false;

	// Prefer Pi's selected-model metadata so OpenAI-only request fields are never
	// added to unrelated providers that happen to use similar model names.
	if (model) {
		return SUPPORTED_APIS.has(String(model.api)) && SUPPORTED_PROVIDERS.has(String(model.provider));
	}

	return true;
}

function commandHelp(): string {
	return [
		"Usage: /fast [on|off|toggle|status]",
		"Fast mode adds service_tier=priority for supported Codex/OpenAI GPT-5.4/GPT-5.5 Responses models.",
		"Unsupported models are left untouched.",
	].join("\n");
}

function activeLabel(ctx: ExtensionContext, state: FastModeState): string {
	if (!state.enabled) return "off";
	return supportsFastMode(ctx.model) ? "on ⚡ (Codex/OpenAI priority)" : "on ⚡ (current model unsupported)";
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

export default function fastModeExtension(pi: ExtensionAPI) {
	const state = loadState();
	saveState(state);
	const stats: FastModeStats = { injectedCount: 0 };
	let requestRender: (() => void) | undefined;

	function persistAndRender() {
		saveState(state);
		requestRender?.();
	}

	function recordInjection(ctx: ExtensionContext, payload: Record<string, unknown>) {
		stats.injectedCount++;
		stats.lastInjectedAt = Date.now();
		stats.lastInjectedModel = String(payload.model ?? ctx.model?.id ?? "unknown");
		stats.lastInjectedProvider = ctx.model?.provider;
		stats.lastInjectedApi = ctx.model?.api;
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		requestRender = () => undefined;
	});

	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});

	pi.on("model_select", (_event, ctx) => {
		requestRender?.();
		if (state.enabled && ctx.hasUI && supportsFastMode(ctx.model)) {
			ctx.ui.notify(`Fast mode active for ${ctx.model.provider}/${ctx.model.id}`, "info");
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!state.enabled || !isObject(event.payload)) return undefined;
		if (!supportsFastMode(ctx.model, event.payload)) return undefined;

		const payload = event.payload as Record<string, unknown>;
		recordInjection(ctx, payload);
		if (payload.service_tier === FAST_SERVICE_TIER) return undefined;
		return { ...payload, service_tier: FAST_SERVICE_TIER };
	});

	async function handleFastCommand(args: string, ctx: ExtensionContext) {
		const action = args.trim().toLowerCase() || "status";

		if (action === "on" || action === "enable" || action === "enabled") {
			state.enabled = true;
			persistAndRender();
			notify(ctx, `Fast mode ${activeLabel(ctx, state)}`, "info");
			return;
		}

		if (action === "off" || action === "disable" || action === "disabled") {
			state.enabled = false;
			persistAndRender();
			notify(ctx, "Fast mode off", "info");
			return;
		}

		if (action === "toggle") {
			state.enabled = !state.enabled;
			persistAndRender();
			notify(ctx, `Fast mode ${state.enabled ? activeLabel(ctx, state) : "off"}`, "info");
			return;
		}

		if (action !== "status") {
			notify(ctx, commandHelp(), "warning");
			return;
		}

		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
		const last = stats.lastInjectedAt ? new Date(stats.lastInjectedAt).toLocaleTimeString() : "never";
		const details = [
			`Fast mode: ${activeLabel(ctx, state)}`,
			`Current model: ${model}`,
			`Supported current model: ${supportsFastMode(ctx.model) ? "yes" : "no"}`,
			`Injected requests: ${stats.injectedCount}`,
			`Last injection: ${last}${stats.lastInjectedModel ? ` (${stats.lastInjectedProvider}/${stats.lastInjectedModel})` : ""}`,
			`State file: ${statePath}`,
		].join("\n");
		notify(ctx, details, "info");
	}

	pi.registerCommand("fast", {
		description: "Toggle Fast mode for supported Codex/OpenAI models. Usage: /fast [on|off|toggle|status]",
		handler: handleFastCommand,
	});
}
