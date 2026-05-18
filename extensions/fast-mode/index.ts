import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type FastModeState = {
	enabled: boolean;
};

type FastRoute = "codex" | "claude" | "unsupported";

type FastModeStats = {
	injectedCount: number;
	codexInjectedCount: number;
	claudeInjectedCount: number;
	lastInjectedAt?: number;
	lastInjectedRoute?: Exclude<FastRoute, "unsupported">;
	lastInjectedModel?: string;
	lastInjectedProvider?: string;
	lastInjectedApi?: string;
	lastResponseStatus?: number;
	lastCooldownAt?: number;
	lastProviderSetup?: string;
};

type ClaudeFastConfig = {
	baseUrl: string;
	apiKeyHelper?: string;
	customHeaders: Record<string, string>;
};

const CODEX_FAST_SERVICE_TIER = "priority";
const SUPPORTED_CODEX_MODEL_RE = /^gpt-5\.(4|5)(?:$|-)/i;
const SUPPORTED_CODEX_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const SUPPORTED_CODEX_PROVIDERS = new Set(["openai", "openai-codex"]);

const SUPPORTED_CLAUDE_MODEL_RE = /(?:^|[-_])opus[-_]?4[-_.]?6(?:$|[-_.])/i;
const SUPPORTED_CLAUDE_API = "anthropic-messages";
const SUPPORTED_CLAUDE_PROVIDER_PREFIX = "anthropic";
const CLAUDE_PROVIDERS_TO_OVERRIDE = ["anthropic", "anthropic-250k-prefer-using-this-one"];
const CLAUDE_FAST_BETA = "fast-mode-2026-02-01";
const CLAUDE_CODE_BETAS = [
	"claude-code-20250219",
	"context-1m-2025-08-07",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"advisor-tool-2026-03-01",
	"effort-2025-11-24",
	CLAUDE_FAST_BETA,
].join(",");

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

function supportsCodexFastMode(model: ExtensionContext["model"] | undefined, payload?: unknown): boolean {
	const modelId = model?.id ?? modelIdFromPayload(payload) ?? "";
	if (!SUPPORTED_CODEX_MODEL_RE.test(modelId)) return false;

	// Prefer Pi's selected-model metadata so OpenAI-only request fields are never
	// added to unrelated providers that happen to use similar model names.
	if (model) {
		return SUPPORTED_CODEX_APIS.has(String(model.api)) && SUPPORTED_CODEX_PROVIDERS.has(String(model.provider));
	}

	return true;
}

function supportsClaudeFastMode(model: ExtensionContext["model"] | undefined, payload?: unknown): boolean {
	const modelId = model?.id ?? modelIdFromPayload(payload) ?? "";
	if (!SUPPORTED_CLAUDE_MODEL_RE.test(modelId)) return false;

	// Claude fast mode is currently only known to work for Anthropic-compatible
	// Opus 4.6 models. Do not route or mutate Sonnet, Opus 4.5/4.7, etc.
	if (model) {
		return String(model.api) === SUPPORTED_CLAUDE_API && String(model.provider).startsWith(SUPPORTED_CLAUDE_PROVIDER_PREFIX);
	}

	return false;
}

function routeFor(model: ExtensionContext["model"] | undefined, payload?: unknown): FastRoute {
	if (supportsClaudeFastMode(model, payload)) return "claude";
	if (supportsCodexFastMode(model, payload)) return "codex";
	return "unsupported";
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
		"Usage: /fast [on|off|toggle|status|reload-provider]",
		"Fast mode is one smart toggle:",
		"- Claude Opus 4.6 on Anthropic providers uses Claude Code fast mode (speed=fast).",
		"- Supported Codex/OpenAI GPT-5.4/GPT-5.5 Responses models use service_tier=priority.",
		"Unsupported models are left untouched.",
	].join("\n");
}

function parseHeaderLines(value: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const rawLine of (value ?? "").replace(/\\n/g, "\n").split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const separator = line.includes(":") ? ":" : line.includes("=") ? "=" : undefined;
		if (!separator) continue;
		const index = line.indexOf(separator);
		const name = line.slice(0, index).trim();
		const headerValue = line.slice(index + 1).trim();
		if (name && headerValue) headers[name] = headerValue;
	}
	return headers;
}

function loadClaudeSettings(): { apiKeyHelper?: string; env?: Record<string, string> } | undefined {
	try {
		const settingsPath = join(homedir(), ".claude", "settings.json");
		if (!existsSync(settingsPath)) return undefined;
		return JSON.parse(readFileSync(settingsPath, "utf8")) as { apiKeyHelper?: string; env?: Record<string, string> };
	} catch {
		return undefined;
	}
}

function loadClaudeFastConfig(): ClaudeFastConfig | undefined {
	const settings = loadClaudeSettings();
	const baseUrl = process.env.PI_CLAUDE_FAST_BASE_URL || settings?.env?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
	if (!baseUrl) return undefined;

	return {
		baseUrl,
		apiKeyHelper: settings?.apiKeyHelper,
		customHeaders: {
			...parseHeaderLines(settings?.env?.ANTHROPIC_CUSTOM_HEADERS),
			...parseHeaderLines(process.env.ANTHROPIC_CUSTOM_HEADERS),
			...parseHeaderLines(process.env.PI_CLAUDE_FAST_CUSTOM_HEADERS),
		},
	};
}

function resolveClaudeFastToken(config: ClaudeFastConfig): string | undefined {
	if (process.env.PI_CLAUDE_FAST_API_KEY) return process.env.PI_CLAUDE_FAST_API_KEY;
	if (config.apiKeyHelper) {
		try {
			return execFileSync(config.apiKeyHelper, { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return undefined;
		}
	}
	return process.env.ANTHROPIC_API_KEY;
}

function ensureSystemArray(system: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(system)) return system.filter(isObject) as Array<Record<string, unknown>>;
	if (typeof system === "string" && system.trim()) return [{ type: "text", text: system }];
	return [];
}

function withClaudeFastPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const system = ensureSystemArray(payload.system);
	const hasAgentIdentity = system.some(
		(block) => typeof block.text === "string" && block.text.includes("Claude Agent SDK"),
	);

	return {
		...payload,
		// The Claude Code fast lane expects the Claude Code/Agent SDK request
		// shape: fast speed, the fast-mode beta header, and adaptive thinking. The
		// identity block mirrors Claude Code without hiding Pi's real system prompt.
		thinking: { type: "adaptive" },
		system: hasAgentIdentity
			? system
			: [
					{
						type: "text",
						text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
						cache_control: { type: "ephemeral" },
					},
					...system,
				],
		speed: "fast",
	};
}

export default function smartFastModeExtension(pi: ExtensionAPI) {
	const state = loadState();
	saveState(state);
	const stats: FastModeStats = { injectedCount: 0, codexInjectedCount: 0, claudeInjectedCount: 0 };
	let requestRender: (() => void) | undefined;
	let previousAnthropicApiKey: string | undefined;
	let previousAnthropicApiKeyCaptured = false;
	let providerConfigured = false;
	let cooldownUntil = 0;

	function configureClaudeProvider() {
		const config = loadClaudeFastConfig();
		if (!config) {
			stats.lastProviderSetup = "no Claude Code fast-lane provider settings detected";
			return false;
		}

		const token = resolveClaudeFastToken(config);
		if (!token) {
			stats.lastProviderSetup = "Claude Code fast-lane provider detected, but no token was resolved";
			return false;
		}

		if (!previousAnthropicApiKeyCaptured) {
			previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
			previousAnthropicApiKeyCaptured = true;
		}
		process.env.ANTHROPIC_API_KEY = token;

		const headers: Record<string, string> = {
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-beta": CLAUDE_CODE_BETAS,
			"user-agent": "claude-cli/2.1.128 (external, sdk-cli)",
			"x-app": "cli",
			Authorization: `Bearer ${token}`,
			...config.customHeaders,
		};

		for (const provider of CLAUDE_PROVIDERS_TO_OVERRIDE) {
			pi.registerProvider(provider, {
				baseUrl: config.baseUrl,
				apiKey: "ANTHROPIC_API_KEY",
				headers,
			});
		}

		providerConfigured = true;
		stats.lastProviderSetup = `claude fast-lane provider enabled (${config.baseUrl})`;
		return true;
	}

	function restoreClaudeProvider() {
		if (providerConfigured) {
			for (const provider of CLAUDE_PROVIDERS_TO_OVERRIDE) pi.unregisterProvider(provider);
			providerConfigured = false;
		}
		if (previousAnthropicApiKeyCaptured) {
			if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
			previousAnthropicApiKeyCaptured = false;
			previousAnthropicApiKey = undefined;
		}
		stats.lastProviderSetup = "claude fast-lane provider disabled";
	}

	function reconcileClaudeProvider(ctx: ExtensionContext) {
		if (state.enabled && supportsClaudeFastMode(ctx.model)) {
			configureClaudeProvider();
		} else {
			restoreClaudeProvider();
		}
	}

	function activeLabel(ctx: ExtensionContext): string {
		if (!state.enabled) return "off";
		const route = routeFor(ctx.model);
		if (route === "claude" && Date.now() < cooldownUntil) return "on ⚡ (Claude cooling down after 429)";
		if (route === "claude" && !providerConfigured) return "on ⚡ (Claude Opus 4.6; proxy not configured)";
		if (route === "claude") return "on ⚡ (Claude Opus 4.6 fast)";
		if (route === "codex") return "on ⚡ (Codex priority)";
		return "on ⚡ (current model unsupported)";
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	function persistAndRender(ctx?: ExtensionContext) {
		saveState(state);
		if (ctx) reconcileClaudeProvider(ctx);
		requestRender?.();
	}

	function recordInjection(ctx: ExtensionContext, payload: Record<string, unknown>, route: Exclude<FastRoute, "unsupported">) {
		stats.injectedCount++;
		if (route === "codex") stats.codexInjectedCount++;
		else stats.claudeInjectedCount++;
		stats.lastInjectedAt = Date.now();
		stats.lastInjectedRoute = route;
		stats.lastInjectedModel = String(payload.model ?? ctx.model?.id ?? "unknown");
		stats.lastInjectedProvider = ctx.model?.provider;
		stats.lastInjectedApi = ctx.model?.api;
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

					const contextPercentDisplay = contextPercent === "?"
						? `?/${formatTokens(contextWindow)}`
						: `${contextPercent}%/${formatTokens(contextWindow)}`;
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
					// The indicator intentionally follows the toggle, not route support, so
					// users always get visible feedback that Fast mode is enabled.
					const modelName = state.enabled ? `${baseModelName} ${theme.fg("warning", "⚡")}` : baseModelName;
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
		reconcileClaudeProvider(ctx);
	});

	// Other provider extensions can re-register Anthropic providers per prompt. This
	// smart extension is intentionally installed under a late-sorting name such as
	// zzz-fast-mode and re-applies the Claude Code fast-lane route only while a
	// supported Claude Opus 4.6 model is selected.
	pi.on("input", async (_event, ctx) => {
		reconcileClaudeProvider(ctx);
		return undefined;
	});

	pi.on("session_shutdown", () => {
		requestRender = undefined;
		restoreClaudeProvider();
	});

	pi.on("model_select", (_event, ctx) => {
		reconcileClaudeProvider(ctx);
		requestRender?.();
		if (state.enabled && ctx.hasUI) {
			const route = routeFor(ctx.model);
			if (route === "claude") ctx.ui.notify(`Fast mode active for Claude ${ctx.model.provider}/${ctx.model.id}`, "info");
			else if (route === "codex") ctx.ui.notify(`Fast mode active for Codex/OpenAI ${ctx.model.provider}/${ctx.model.id}`, "info");
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!state.enabled || !isObject(event.payload)) return undefined;

		const route = routeFor(ctx.model, event.payload);
		const payload = event.payload as Record<string, unknown>;

		if (route === "codex") {
			recordInjection(ctx, payload, "codex");
			if (payload.service_tier === CODEX_FAST_SERVICE_TIER) return undefined;
			return { ...payload, service_tier: CODEX_FAST_SERVICE_TIER };
		}

		if (route === "claude") {
			if (Date.now() < cooldownUntil) return undefined;
			// Provider routing has to be installed before Pi builds/sends the provider
			// request. If setup failed earlier, do not add Claude-Code-only fields to a
			// normal Anthropic request.
			if (!providerConfigured) return undefined;
			recordInjection(ctx, payload, "claude");
			if (payload.speed === "fast") return undefined;
			return withClaudeFastPayload(payload);
		}

		return undefined;
	});

	pi.on("after_provider_response", (event) => {
		stats.lastResponseStatus = event.status;
		if (event.status === 429 && state.enabled && providerConfigured) {
			stats.lastCooldownAt = Date.now();
			cooldownUntil = Date.now() + 60_000;
			requestRender?.();
		}
	});

	async function handleFastCommand(args: string, ctx: ExtensionContext) {
		const action = args.trim().toLowerCase() || "status";

		if (action === "on" || action === "enable" || action === "enabled") {
			state.enabled = true;
			cooldownUntil = 0;
			persistAndRender(ctx);
			notify(ctx, `Fast mode ${activeLabel(ctx)}`, "info");
			return;
		}

		if (action === "off" || action === "disable" || action === "disabled") {
			state.enabled = false;
			cooldownUntil = 0;
			persistAndRender(ctx);
			notify(ctx, "Fast mode off", "info");
			return;
		}

		if (action === "toggle") {
			state.enabled = !state.enabled;
			cooldownUntil = 0;
			persistAndRender(ctx);
			notify(ctx, `Fast mode ${state.enabled ? activeLabel(ctx) : "off"}`, "info");
			return;
		}

		if (action === "reload-provider") {
			restoreClaudeProvider();
			reconcileClaudeProvider(ctx);
			requestRender?.();
			notify(ctx, stats.lastProviderSetup ?? "Provider reloaded", "info");
			return;
		}

		if (action !== "status") {
			notify(ctx, commandHelp(), "warning");
			return;
		}

		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
		const last = stats.lastInjectedAt ? new Date(stats.lastInjectedAt).toLocaleTimeString() : "never";
		const cooldown = Date.now() < cooldownUntil ? `${Math.ceil((cooldownUntil - Date.now()) / 1000)}s remaining` : "none";
		const details = [
			`Fast mode: ${activeLabel(ctx)}`,
			`Current model: ${model}`,
			`Current route: ${routeFor(ctx.model)}`,
			`Injected requests: ${stats.injectedCount} (${stats.codexInjectedCount} codex, ${stats.claudeInjectedCount} claude)`,
			`Last injection: ${last}${stats.lastInjectedModel ? ` (${stats.lastInjectedRoute} ${stats.lastInjectedProvider}/${stats.lastInjectedModel})` : ""}`,
			`Last response status: ${stats.lastResponseStatus ?? "n/a"}`,
			`Claude 429 cooldown: ${cooldown}`,
			`Claude provider setup: ${stats.lastProviderSetup ?? "n/a"}`,
			`State file: ${statePath}`,
		].join("\n");
		notify(ctx, details, "info");
	}

	pi.registerCommand("fast", {
		description: "Toggle smart Fast mode for Claude Opus 4.6 and supported Codex/OpenAI models. Usage: /fast [on|off|toggle|status]",
		handler: handleFastCommand,
	});

}
