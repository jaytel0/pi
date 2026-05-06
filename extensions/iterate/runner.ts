/**
 * Parallel Pi process runner for iterate extension
 *
 * Spawns N `pi` processes in JSON mode, one per worktree,
 * and streams progress back to the parent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Message } from "@mariozechner/pi-ai";

export interface IterationRunConfig {
	index: number;
	cwd: string;
	prompt: string;
	branch: string;
}

export interface IterationProgress {
	index: number;
	branch: string;
	status: "pending" | "running" | "done" | "failed";
	turns: number;
	lastToolCall?: string;
	lastToolArgs?: Record<string, any>;
	lastText?: string;
	filesModified: string[];
	messages: Message[];
	exitCode?: number;
	error?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
}

export interface RunResult {
	iterations: IterationProgress[];
	totalCost: number;
	elapsed: number;
}

type ProgressCallback = (iterations: IterationProgress[]) => void;

const MAX_CONCURRENCY = 4;

/**
 * Run N pi agents in parallel, each in its own worktree.
 */
export async function runIterations(
	configs: IterationRunConfig[],
	signal: AbortSignal | undefined,
	onProgress: ProgressCallback,
): Promise<RunResult> {
	const startTime = Date.now();

	const progress: IterationProgress[] = configs.map((c) => ({
		index: c.index,
		branch: c.branch,
		status: "pending",
		turns: 0,
		filesModified: [],
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	}));

	const emitProgress = () => onProgress([...progress]);
	emitProgress();

	// Run with concurrency limit
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, configs.length) }, async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= configs.length) return;
			await runSingle(configs[current], progress[current], signal, emitProgress);
		}
	});

	await Promise.all(workers);

	const totalCost = progress.reduce((sum, p) => sum + p.usage.cost, 0);
	return { iterations: progress, totalCost, elapsed: Date.now() - startTime };
}

async function runSingle(
	config: IterationRunConfig,
	progress: IterationProgress,
	signal: AbortSignal | undefined,
	emitProgress: () => void,
): Promise<void> {
	progress.status = "running";
	emitProgress();

	const args = ["--mode", "json", "-p", "--no-session", config.prompt];

	let proc: ChildProcess;
	try {
		proc = spawn("pi", args, {
			cwd: config.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e: any) {
		progress.status = "failed";
		progress.error = `Failed to spawn pi: ${e.message}`;
		emitProgress();
		return;
	}

	let buffer = "";
	let stderr = "";

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		// Track tool execution starts for live status
		if (event.type === "tool_execution_start") {
			progress.lastToolCall = event.toolName;
			progress.lastToolArgs = event.args;

			// Track file modifications
			const filePath = event.args?.path || event.args?.file_path;
			if (filePath && (event.toolName === "write" || event.toolName === "edit")) {
				if (!progress.filesModified.includes(filePath)) {
					progress.filesModified.push(filePath);
				}
			}

			emitProgress();
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message as Message;
			progress.messages.push(msg);

			if (msg.role === "assistant") {
				progress.turns++;
				const usage = msg.usage;
				if (usage) {
					progress.usage.input += usage.input || 0;
					progress.usage.output += usage.output || 0;
					progress.usage.cacheRead += usage.cacheRead || 0;
					progress.usage.cacheWrite += usage.cacheWrite || 0;
					progress.usage.cost += usage.cost?.total || 0;
				}

				// Extract last text content for status display
				for (const part of msg.content) {
					if (part.type === "text") {
						progress.lastText = part.text.slice(0, 200);
					}
					if (part.type === "toolCall") {
						progress.lastToolCall = part.name;
						progress.lastToolArgs = part.arguments as Record<string, any>;
					}
				}
			}

			emitProgress();
		}

		if (event.type === "tool_result_end" && event.message) {
			progress.messages.push(event.message as Message);
			emitProgress();
		}
	};

	return new Promise<void>((resolve) => {
		proc.stdout!.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr!.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			progress.exitCode = code ?? 0;
			if (code === 0) {
				progress.status = "done";
			} else if (signal?.aborted) {
				// Killed intentionally (e.g. time limit) — treat as done with partial results
				progress.status = "done";
			} else {
				progress.status = "failed";
				if (stderr) progress.error = stderr.slice(-500);
			}
			emitProgress();
			resolve();
		});

		proc.on("error", (err) => {
			progress.status = "failed";
			progress.error = err.message;
			emitProgress();
			resolve();
		});

		// Abort handling
		if (signal) {
			const kill = () => {
				try {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 3000);
				} catch {
					// Already dead
				}
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

/**
 * Extract the final assistant text output from messages.
 */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Count tool calls in messages by tool name.
 */
export function countToolCalls(messages: Message[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "toolCall") {
					counts[part.name] = (counts[part.name] || 0) + 1;
				}
			}
		}
	}
	return counts;
}
