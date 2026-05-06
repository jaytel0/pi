import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type FastModeState = {
	enabled: boolean;
};

type FastModeStats = {
	injectedCount: number;
	lastInjectedAt?: number;
	lastInjectedModel?: string;
	lastInjectedProvider?: string;
	lastInjectedApi?: string;
	lastResponseStatus?: number;
};

const FAST_SERVICE_TIER = "priority";
const SUPPORTED_FAST_MODEL_RE = /^gpt-5\.(4|5)(?:$|-)/i;
const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-codex"]);

const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const statePath = join(configDir, "fast-mode.json");

function loadState(): FastModeState {
	try {
		if (!existsSync(statePath)) return { enabled: false };
		const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<FastModeState>;
		return { enabled: parsed.enabled === true };
	} catch {
		return { enabled: false };
	}
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
	if (!SUPPORTED_FAST_MODEL_RE.test(modelId)) return false;

	// Prefer Pi's model metadata when available so we do not add OpenAI-only
	// fields to unrelated providers that happen to use similar model names.
	if (model) {
		return SUPPORTED_APIS.has(String(model.api)) && SUPPORTED_PROVIDERS.has(String(model.provider));
	}

	return true;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function commandHelp(): string {
	return [
		"Usage: /fast [on|off|toggle|status]",
		"Fast mode injects service_tier=priority into supported OpenAI GPT-5.4/GPT-5.5 Responses requests.",
	].join("\n");
}

export default function openAIFastModeExtension(pi: ExtensionAPI) {
	const state = loadState();
	const stats: FastModeStats = { injectedCount: 0 };
	let requestRender: (() => void) | undefined;

	function isFastActiveForContext(ctx: ExtensionContext): boolean {
		return state.enabled && supportsFastMode(ctx.model);
	}

	function activeLabel(ctx: ExtensionContext): string {
		if (!state.enabled) return "off";
		return supportsFastMode(ctx.model) ? "on ⚡" : "on (current model unsupported)";
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	function persistAndRender() {
		saveState(state);
		requestRender?.();
	}

	function installFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange?.(() => tui.requestRender());

			return {
				dispose: unsubscribeBranch,
				invalidate() {},
				render(width: number): string[] {
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const usage = entry.message.usage;
							totalInput += usage.input;
							totalOutput += usage.output;
							totalCacheRead += usage.cacheRead;
							totalCacheWrite += usage.cacheWrite;
							totalCost += usage.cost.total;
						}
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
						? contextPercentValue.toFixed(1)
						: "?";

					let pwd = formatCwd(ctx.cwd);
					const branch = footerData.getGitBranch?.();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = (ctx.sessionManager as unknown as { getSessionName?: () => string | undefined }).getSessionName?.();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

					const isUsingOAuth = ctx.model
						? (ctx.modelRegistry as unknown as { isUsingOAuth?: (model: typeof ctx.model) => boolean }).isUsingOAuth?.(ctx.model) === true
						: false;
					if (totalCost || isUsingOAuth) {
						statsParts.push(`$${totalCost.toFixed(3)}${isUsingOAuth ? " (sub)" : ""}`);
					}

					const autoIndicator = "";
					const contextPercentDisplay = contextPercent === "?"
						? `?/${formatTokens(contextWindow)}${autoIndicator}`
						: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
					let contextPercentStr = contextPercentDisplay;
					if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
					else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const baseModelName = ctx.model?.id || "no-model";
					const modelName = isFastActiveForContext(ctx) ? `${baseModelName} ${theme.fg("warning", "⚡")}` : baseModelName;
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel?.() || "off";
						rightSideWithoutProvider = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}

					let rightSide = rightSideWithoutProvider;
					const availableProviderCount = footerData.getAvailableProviderCount?.() ?? 1;
					if (availableProviderCount > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					const minPadding = 2;
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
					let statsLine: string;
					if (totalNeeded <= width) {
						statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + theme.fg("dim", remainder)];

					const extensionStatuses = footerData.getExtensionStatuses?.();
					if (extensionStatuses && extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(String(text)))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		installFooter(ctx);
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
		if (!state.enabled || !supportsFastMode(ctx.model, event.payload) || !isObject(event.payload)) {
			return undefined;
		}

		const payload = event.payload as Record<string, unknown>;
		stats.injectedCount++;
		stats.lastInjectedAt = Date.now();
		stats.lastInjectedModel = String(payload.model ?? ctx.model?.id ?? "unknown");
		stats.lastInjectedProvider = ctx.model?.provider;
		stats.lastInjectedApi = ctx.model?.api;

		if (payload.service_tier === FAST_SERVICE_TIER) return undefined;
		return { ...payload, service_tier: FAST_SERVICE_TIER };
	});

	pi.on("after_provider_response", (event) => {
		stats.lastResponseStatus = event.status;
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI GPT-5.4/GPT-5.5 Fast mode. Usage: /fast [on|off|toggle|status]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";

			if (action === "on" || action === "enable" || action === "enabled") {
				state.enabled = true;
				persistAndRender();
				notify(ctx, `Fast mode on${supportsFastMode(ctx.model) ? " ⚡" : " (current model unsupported)"}`, "info");
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
				notify(ctx, `Fast mode ${state.enabled ? activeLabel(ctx) : "off"}`, "info");
				return;
			}

			if (action !== "status") {
				notify(ctx, commandHelp(), "warning");
				return;
			}

			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
			const last = stats.lastInjectedAt ? new Date(stats.lastInjectedAt).toLocaleTimeString() : "never";
			const details = [
				`Fast mode: ${activeLabel(ctx)}`,
				`Current model: ${model}`,
				`Injected requests: ${stats.injectedCount}`,
				`Last injection: ${last}${stats.lastInjectedModel ? ` (${stats.lastInjectedProvider}/${stats.lastInjectedModel})` : ""}`,
				`Last response status: ${stats.lastResponseStatus ?? "n/a"}`,
				`State file: ${statePath}`,
			].join("\n");
			notify(ctx, details, "info");
		},
	});
}
