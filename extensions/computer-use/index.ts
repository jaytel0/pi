import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Type } from "typebox";

const SERVER_NAME = "computer-use";
const DEFAULT_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const CONDUCTOR_CODEX_BIN = "/Applications/Conductor.app/Contents/Resources/bin/codex";
const REQUEST_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 90_000;
const MAX_LOG_LINES = 80;

const AppParam = Type.String({ description: "App name or bundle identifier, e.g. Slack or com.tinyspeck.slackmacgap" });

const TOOL_DEFS = [
	{
		mcpName: "list_apps",
		piName: "computer_use_list_apps",
		label: "Computer Use: List Apps",
		description:
			"List apps on this Mac that Computer Use can see, including running apps and recently used apps.",
		promptSnippet: "List running and recently used macOS apps available to Computer Use.",
		parameters: Type.Object({}, { additionalProperties: false }),
	},
	{
		mcpName: "get_app_state",
		piName: "computer_use_get_app_state",
		label: "Computer Use: Get App State",
		description:
			"Start an app-use session if needed, then get the state of the app's key window, including screenshot/accessibility tree. Call this before interacting with an app.",
		promptSnippet: "Inspect a macOS app window via screenshot and accessibility tree before controlling it.",
		parameters: Type.Object({ app: AppParam }, { additionalProperties: false }),
	},
	{
		mcpName: "click",
		piName: "computer_use_click",
		label: "Computer Use: Click",
		description:
			"Click an app element by accessibility element_index or by screenshot pixel coordinates. Call computer_use_get_app_state first.",
		promptSnippet: "Click in a macOS app using Computer Use element indexes or pixel coordinates.",
		parameters: Type.Object(
			{
				app: AppParam,
				element_index: Type.Optional(Type.String({ description: "Element index from get_app_state to click" })),
				x: Type.Optional(Type.Number({ description: "X coordinate in screenshot pixel coordinates" })),
				y: Type.Optional(Type.Number({ description: "Y coordinate in screenshot pixel coordinates" })),
				click_count: Type.Optional(Type.Integer({ description: "Number of clicks. Defaults to 1" })),
				mouse_button: Type.Optional(
					Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
						description: "Mouse button to click. Defaults to left.",
					}),
				),
			},
			{ additionalProperties: false },
		),
	},
	{
		mcpName: "type_text",
		piName: "computer_use_type_text",
		label: "Computer Use: Type Text",
		description:
			"Type literal text using keyboard input into the target app. Call computer_use_get_app_state first and focus the right field first if needed.",
		promptSnippet: "Type literal text into a macOS app through Computer Use.",
		parameters: Type.Object(
			{
				app: AppParam,
				text: Type.String({ description: "Literal text to type" }),
			},
			{ additionalProperties: false },
		),
	},
	{
		mcpName: "press_key",
		piName: "computer_use_press_key",
		label: "Computer Use: Press Key",
		description:
			"Press a key or key combination in the target app, e.g. Return, Tab, Escape, Up, super+c. Call computer_use_get_app_state first.",
		promptSnippet: "Press keyboard keys or shortcuts in a macOS app through Computer Use.",
		parameters: Type.Object(
			{
				app: AppParam,
				key: Type.String({ description: "Key or key combination to press" }),
			},
			{ additionalProperties: false },
		),
	},
	{
		mcpName: "scroll",
		piName: "computer_use_scroll",
		label: "Computer Use: Scroll",
		description:
			"Scroll an accessibility element in a direction by a number of pages. Call computer_use_get_app_state first.",
		promptSnippet: "Scroll within a macOS app element through Computer Use.",
		parameters: Type.Object(
			{
				app: AppParam,
				element_index: Type.String({ description: "Element identifier from get_app_state" }),
				direction: Type.Union(
					[Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")],
					{ description: "Scroll direction" },
				),
				pages: Type.Optional(Type.Number({ description: "Number of pages to scroll. Defaults to 1." })),
			},
			{ additionalProperties: false },
		),
	},
	{
		mcpName: "drag",
		piName: "computer_use_drag",
		label: "Computer Use: Drag",
		description:
			"Drag from one screenshot pixel coordinate to another. Call computer_use_get_app_state first.",
		promptSnippet: "Drag between pixel coordinates in a macOS app through Computer Use.",
		parameters: Type.Object(
			{
				app: AppParam,
				from_x: Type.Number({ description: "Start X coordinate" }),
				from_y: Type.Number({ description: "Start Y coordinate" }),
				to_x: Type.Number({ description: "End X coordinate" }),
				to_y: Type.Number({ description: "End Y coordinate" }),
			},
			{ additionalProperties: false },
		),
	},
	{
		mcpName: "set_value",
		piName: "computer_use_set_value",
		label: "Computer Use: Set Value",
		description:
			"Set the value of a settable accessibility element. Call computer_use_get_app_state first.",
		promptSnippet: "Set a value on a macOS accessibility element through Computer Use.",
		parameters: Type.Object(
			{
				app: AppParam,
				element_index: Type.String({ description: "Element identifier from get_app_state" }),
				value: Type.String({ description: "Value to assign" }),
			},
			{ additionalProperties: false },
		),
	},
	{
		mcpName: "perform_secondary_action",
		piName: "computer_use_perform_secondary_action",
		label: "Computer Use: Secondary Action",
		description:
			"Invoke a secondary accessibility action exposed by an element. Call computer_use_get_app_state first.",
		promptSnippet: "Invoke secondary accessibility actions in a macOS app through Computer Use.",
		parameters: Type.Object(
			{
				app: AppParam,
				element_index: Type.String({ description: "Element identifier from get_app_state" }),
				action: Type.String({ description: "Secondary accessibility action name" }),
			},
			{ additionalProperties: false },
		),
	},
] as const;

type JsonRpcMessage = {
	id?: number | string;
	method?: string;
	params?: any;
	result?: any;
	error?: any;
};

type PendingRequest = {
	resolve: (value: any) => void;
	reject: (reason: any) => void;
	timer: NodeJS.Timeout;
};

function findCodexBin(): string | undefined {
	const fromEnv = process.env.PI_COMPUTER_USE_CODEX_BIN || process.env.CODEX_BIN;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	if (existsSync(DEFAULT_CODEX_BIN)) return DEFAULT_CODEX_BIN;
	if (existsSync(CONDUCTOR_CODEX_BIN)) return CONDUCTOR_CODEX_BIN;
	return undefined;
}

function compactJson(value: unknown, limit = 1400): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function normalizeMcpContent(result: any): any[] {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content.map((item: any) => {
		if (item?.type === "text") return { type: "text", text: String(item.text ?? "") };
		if (item?.type === "image") {
			return {
				type: "image",
				data: item.data,
				mimeType: item.mimeType ?? item.mime_type ?? "image/png",
			};
		}
		return { type: "text", text: compactJson(item) };
	});
}

class CodexAppServerClient {
	private child?: ChildProcessWithoutNullStreams;
	private rl?: ReadlineInterface;
	private nextId = 1;
	private pending = new Map<number | string, PendingRequest>();
	private logs: string[] = [];
	private _alive = false;

	constructor(
		private readonly codexBin: string,
		private readonly cwd: string,
	) {}

	get alive(): boolean {
		return this._alive && !!this.child && !this.child.killed;
	}

	get recentLogs(): string[] {
		return [...this.logs];
	}

	start() {
		if (this.alive) return;
		this.child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
			cwd: this.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this._alive = true;

		this.rl = createInterface({ input: this.child.stdout });
		this.rl.on("line", (line) => this.handleLine(line));
		this.child.stderr.on("data", (chunk) => this.addLog(String(chunk)));
		this.child.on("exit", (code, signal) => {
			this._alive = false;
			this.addLog(`codex app-server exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
			this.rejectAll(new Error(`codex app-server exited: ${code ?? signal ?? "unknown"}`));
		});
		this.child.on("error", (error) => {
			this._alive = false;
			this.addLog(`codex app-server error: ${error.message}`);
			this.rejectAll(error);
		});
	}

	async initialize() {
		this.start();
		await this.request(
			"initialize",
			{
				clientInfo: {
					name: "pi_computer_use",
					title: "Pi Computer Use Bridge",
					version: "0.1.0",
				},
				capabilities: { experimentalApi: true },
			},
			START_TIMEOUT_MS,
		);
		this.notify("initialized", {});
	}

	request(method: string, params: any = {}, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<any> {
		if (!this.child || !this.alive) this.start();
		if (!this.child?.stdin.writable) return Promise.reject(new Error("codex app-server stdin is not writable"));

		const id = this.nextId++;
		const payload = JSON.stringify({ id, method, params });

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for Codex app-server method ${method}`));
			}, timeoutMs);
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`Aborted Codex app-server method ${method}`));
			};
			if (signal) {
				if (signal.aborted) return onAbort();
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pending.set(id, {
				resolve: (value) => {
					if (signal) signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (reason) => {
					if (signal) signal.removeEventListener("abort", onAbort);
					reject(reason);
				},
				timer,
			});
			this.child?.stdin.write(`${payload}\n`);
		});
	}

	notify(method: string, params: any = {}) {
		if (!this.child?.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
	}

	respond(id: number | string, result: any) {
		if (!this.child?.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
	}

	respondError(id: number | string, message: string) {
		if (!this.child?.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
	}

	stop() {
		this._alive = false;
		this.rl?.close();
		this.rl = undefined;
		this.rejectAll(new Error("codex app-server stopped"));
		if (this.child && !this.child.killed) {
			this.child.kill("SIGTERM");
		}
		this.child = undefined;
	}

	private handleLine(line: string) {
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse(line);
		} catch {
			this.addLog(`non-JSON stdout: ${line}`);
			return;
		}

		if (msg.id !== undefined && !msg.method) {
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			clearTimeout(pending.timer);
			if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
			else pending.resolve(msg.result);
			return;
		}

		if (msg.id !== undefined && msg.method) {
			void this.handleServerRequest(msg);
			return;
		}

		if (msg.method === "mcpServer/startupStatus/updated") {
			const params = msg.params ?? {};
			this.addLog(`mcp ${params.name}: ${params.status}${params.error ? ` (${params.error})` : ""}`);
		}
	}

	private async handleServerRequest(msg: JsonRpcMessage) {
		const id = msg.id;
		if (id === undefined) return;
		try {
			if (msg.method === "mcpServer/elicitation/request") {
				this.respond(id, answerElicitation(msg.params));
				return;
			}

			if (msg.method?.includes("requestApproval")) {
				this.respond(id, { decision: "accept" });
				return;
			}

			if (msg.method === "tool/requestUserInput") {
				this.respond(id, { answers: [] });
				return;
			}

			this.respondError(id, `Unsupported server request from Codex app-server: ${msg.method}`);
		} catch (error: any) {
			this.respondError(id, error?.message ?? String(error));
		}
	}

	private addLog(text: string) {
		for (const line of text.split(/\r?\n/).filter(Boolean)) {
			this.logs.push(line);
		}
		if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
	}

	private rejectAll(error: Error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

function answerElicitation(params: any) {
	const request = params?.request ?? params;
	const schema = request?.requestedSchema ?? request?.schema;
	const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
	const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
	const content: Record<string, unknown> = {};

	for (const key of required) {
		const property = properties[key] ?? {};
		if (property.default !== undefined) content[key] = property.default;
		else if (property.type === "number" || property.type === "integer") content[key] = 0;
		else if (property.type === "boolean") content[key] = true;
		else content[key] = "";
	}

	return { action: "accept", content };
}

export default function computerUseExtension(pi: ExtensionAPI) {
	let client: CodexAppServerClient | undefined;
	let threadId: string | undefined;
	let sessionCwd: string | undefined;
	let startPromise: Promise<void> | undefined;
	let lastError: string | undefined;
	let queue: Promise<unknown> = Promise.resolve();
	const lastAppStateAt = new Map<string, number>();

	function resetState() {
		threadId = undefined;
		lastAppStateAt.clear();
	}

	function stopClient() {
		client?.stop();
		client = undefined;
		startPromise = undefined;
		resetState();
	}

	async function ensureStarted(ctx: ExtensionContext, signal?: AbortSignal) {
		if (client?.alive && threadId && sessionCwd === ctx.cwd) return;
		if (startPromise && sessionCwd === ctx.cwd) {
			await startPromise;
			return;
		}

		startPromise = (async () => {
			lastError = undefined;
			const codexBin = findCodexBin();
			if (!codexBin) {
				throw new Error(
					`Codex binary not found. Set PI_COMPUTER_USE_CODEX_BIN, or install Codex at ${DEFAULT_CODEX_BIN}.`,
				);
			}

			stopClient();
			sessionCwd = ctx.cwd;
			client = new CodexAppServerClient(codexBin, ctx.cwd);
			await client.initialize();
			const threadResult = await client.request(
				"thread/start",
				{
					cwd: ctx.cwd,
					ephemeral: true,
					approvalPolicy: "never",
					sandbox: "read-only",
				},
				START_TIMEOUT_MS,
				signal,
			);
			threadId = threadResult?.thread?.id;
			if (!threadId) throw new Error(`Codex app-server did not return a thread id: ${compactJson(threadResult)}`);
		})().catch((error: any) => {
			lastError = error?.message ?? String(error);
			stopClient();
			throw error;
		}).finally(() => {
			startPromise = undefined;
		});

		await startPromise;
	}

	async function callComputerUseTool(mcpName: string, params: any, ctx: ExtensionContext, signal?: AbortSignal) {
		await ensureStarted(ctx, signal);
		if (!client || !threadId) throw new Error("Computer Use bridge is not initialized");
		const result = await client.request(
			"mcpServer/tool/call",
			{
				threadId,
				server: SERVER_NAME,
				tool: mcpName,
				arguments: params ?? {},
			},
			REQUEST_TIMEOUT_MS,
			signal,
		);
		return result;
	}

	async function runQueued<T>(work: () => Promise<T>): Promise<T> {
		const previous = queue.catch(() => undefined);
		let release!: () => void;
		queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await work();
		} finally {
			release();
		}
	}

	for (const def of TOOL_DEFS) {
		pi.registerTool({
			name: def.piName,
			label: def.label,
			description: def.description,
			promptSnippet: def.promptSnippet,
			promptGuidelines: [
				"Use computer_use_list_apps when you need to know the exact macOS app name or bundle identifier before using Computer Use.",
				"Use computer_use_get_app_state before calling any Computer Use action tool for an app; use the returned element indexes or screenshot coordinates for follow-up actions.",
				"Do not call Computer Use action tools in parallel with computer_use_get_app_state; inspect first, then act in a later step.",
			],
			parameters: def.parameters,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					const result = await runQueued(() => callComputerUseTool(def.mcpName, params, ctx, signal));
					if (def.mcpName === "get_app_state" && params?.app && !result?.isError) {
						lastAppStateAt.set(String(params.app), Date.now());
					}

					const content = normalizeMcpContent(result);
					if (content.length === 0) content.push({ type: "text", text: compactJson(result) });
					return {
						content,
						details: {
							tool: def.mcpName,
							isError: !!result?.isError,
							meta: result?._meta,
						},
						isError: !!result?.isError,
					};
				} catch (error: any) {
					lastError = error?.message ?? String(error);
					return {
						content: [
							{
								type: "text",
								text:
									`Computer Use bridge error while running ${def.mcpName}: ${lastError}\n\n` +
									`If Codex/Computer Use was updated, try /computer-use-restart.`,
							},
						],
						details: { tool: def.mcpName, error: lastError, logs: client?.recentLogs.slice(-12) ?? [] },
						isError: true,
					};
				}
			},
		});
	}

	pi.registerCommand("computer-use-status", {
		description: "Show Codex Computer Use bridge status",
		handler: async (_args, ctx) => {
			const codexBin = findCodexBin();
			let statusText = [
				`Codex binary: ${codexBin ?? "not found"}`,
				`Bridge alive: ${client?.alive ? "yes" : "no"}`,
				`Thread: ${threadId ?? "not started"}`,
				`Cwd: ${sessionCwd ?? ctx.cwd}`,
				`Permission prompts: disabled` ,
				`Last error: ${lastError ?? "none"}`,
			].join("\n");

			try {
				await ensureStarted(ctx);
				if (client) {
					const mcp = await client.request("mcpServerStatus/list", { detail: "full", limit: 100 }, START_TIMEOUT_MS);
					const computerUse = mcp?.data?.find((server: any) => server.name === SERVER_NAME);
					statusText += `\nComputer Use server: ${computerUse ? "present" : "missing"}`;
					statusText += `\nComputer Use tool count: ${computerUse?.tools ? Object.keys(computerUse.tools).length : 0}`;
				}
			} catch (error: any) {
				statusText += `\nStatus check failed: ${error?.message ?? String(error)}`;
			}

			const logs = client?.recentLogs.slice(-10) ?? [];
			if (logs.length > 0) statusText += `\n\nRecent bridge logs:\n${logs.join("\n")}`;
			ctx.ui.notify(statusText, lastError ? "warning" : "info");
		},
	});

	pi.registerCommand("computer-use-restart", {
		description: "Restart the Codex Computer Use bridge",
		handler: async (_args, ctx) => {
			stopClient();
			try {
				await ensureStarted(ctx);
				ctx.ui.notify(`Computer Use bridge restarted. Thread: ${threadId}`, "success");
			} catch (error: any) {
				ctx.ui.notify(`Computer Use bridge restart failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("computer-use-tools", {
		description: "List Pi tools exposed by the Codex Computer Use bridge",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				TOOL_DEFS.map((tool) => `${tool.piName} → ${SERVER_NAME}/${tool.mcpName}`).join("\n"),
				"info",
			);
		},
	});

	pi.on("agent_start", () => {
		lastAppStateAt.clear();
	});

	pi.on("session_shutdown", () => {
		stopClient();
	});
}
