/**
 * Live progress widget for iterate extension
 *
 * Shows a persistent widget above the editor with real-time
 * status of all running iterations. Updates as JSON events stream in.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { IterationProgress } from "./runner.js";

export interface WidgetState {
	phase: "idle" | "creating" | "installing" | "running" | "done";
	iterations: IterationProgress[];
	sessionId?: string;
	baseBranch?: string;
	startTime?: number;
}

let state: WidgetState = { phase: "idle", iterations: [] };

export function getWidgetState(): WidgetState {
	return state;
}

export function setWidgetPhase(ctx: ExtensionContext, phase: WidgetState["phase"], meta?: Partial<WidgetState>) {
	state = { ...state, phase, ...meta };
	renderWidget(ctx);
}

export function updateIterationProgress(ctx: ExtensionContext, iterations: IterationProgress[]) {
	state = { ...state, iterations };
	renderWidget(ctx);
}

export function clearWidget(ctx: ExtensionContext) {
	state = { phase: "idle", iterations: [] };
	ctx.ui.setWidget("iterate-progress", undefined);
	ctx.ui.setStatus("iterate", undefined);
}

function renderWidget(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const theme = ctx.ui.theme;

	if (state.phase === "idle") {
		ctx.ui.setWidget("iterate-progress", undefined);
		return;
	}

	// ─── Phase: creating / installing ───
	if (state.phase === "creating" || state.phase === "installing") {
		const label = state.phase === "creating" ? "Creating worktrees..." : "Installing dependencies...";
		ctx.ui.setStatus("iterate", theme.fg("warning", `🔀 ${label}`));
		ctx.ui.setWidget("iterate-progress", [theme.fg("dim", `  ${label}`)]);
		return;
	}

	// ─── Phase: running ───
	if (state.phase === "running") {
		const elapsed = state.startTime ? formatElapsed(Date.now() - state.startTime) : "";
		const running = state.iterations.filter((i) => i.status === "running").length;
		const done = state.iterations.filter((i) => i.status === "done" || i.status === "failed").length;
		const total = state.iterations.length;

		// Status bar (footer)
		const statusParts: string[] = [`${done}/${total} done`];
		if (running > 0) statusParts.push(`${running} running`);
		if (elapsed) statusParts.push(elapsed);
		const totalCost = state.iterations.reduce((s, i) => s + i.usage.cost, 0);
		if (totalCost > 0) statusParts.push(`$${totalCost.toFixed(4)}`);
		ctx.ui.setStatus("iterate", theme.fg("warning", `🔀 ${statusParts.join(" · ")}`));

		// Widget lines (above editor)
		const lines = buildProgressLines(ctx);
		ctx.ui.setWidget("iterate-progress", lines);
		return;
	}

	// ─── Phase: done ───
	if (state.phase === "done") {
		const succeeded = state.iterations.filter((i) => i.status === "done").length;
		const failed = state.iterations.filter((i) => i.status === "failed").length;
		const totalCost = state.iterations.reduce((s, i) => s + i.usage.cost, 0);
		const elapsed = state.startTime ? formatElapsed(Date.now() - state.startTime) : "";

		const statusParts = [`${succeeded}✓`];
		if (failed > 0) statusParts.push(`${failed}✗`);
		statusParts.push(`$${totalCost.toFixed(4)}`);
		if (elapsed) statusParts.push(elapsed);

		ctx.ui.setStatus("iterate", theme.fg("success", `🔀 Done: ${statusParts.join(" · ")} — /iterate-pick to choose winner`));

		const lines = buildProgressLines(ctx);
		lines.push("");
		lines.push(theme.fg("dim", "  /iterate-serve to preview · /iterate-pick to choose winner · /iterate-cleanup to remove"));
		ctx.ui.setWidget("iterate-progress", lines);
	}
}

function buildProgressLines(ctx: ExtensionContext): string[] {
	const theme = ctx.ui.theme;
	const lines: string[] = [];

	// Header
	const branchLabel = state.baseBranch ? theme.fg("dim", ` from ${state.baseBranch}`) : "";
	lines.push(theme.fg("accent", theme.bold("  ┌─ Iterations")) + branchLabel);

	for (const iter of state.iterations) {
		const icon = getStatusIcon(iter.status, theme);
		const idx = theme.fg("accent", `#${iter.index}`);

		// Progress bar
		const bar = renderMiniBar(iter, theme);

		// Activity detail
		const activity = getActivityLabel(iter, theme);

		// Cost
		const cost = iter.usage.cost > 0 ? theme.fg("dim", ` $${iter.usage.cost.toFixed(4)}`) : "";

		lines.push(`  │ ${icon} ${idx} ${bar} ${activity}${cost}`);

		// Show last tool call or text snippet on a second line for running iterations
		if (iter.status === "running" && iter.lastToolCall) {
			const toolDetail = formatToolDetail(iter, theme);
			if (toolDetail) {
				lines.push(`  │   ${toolDetail}`);
			}
		}
	}

	lines.push(theme.fg("accent", "  └─"));

	return lines;
}

function getStatusIcon(status: IterationProgress["status"], theme: any): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "running":
			return theme.fg("warning", "●");
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
	}
}

function renderMiniBar(iter: IterationProgress, theme: any): string {
	if (iter.status === "pending") return theme.fg("dim", "waiting");
	if (iter.status === "done") return theme.fg("success", `${iter.turns} turns`);
	if (iter.status === "failed") return theme.fg("error", "failed");

	// Running — show turns as a simple counter
	const turnsLabel = iter.turns === 1 ? "1 turn" : `${iter.turns} turns`;
	return theme.fg("warning", turnsLabel);
}

function getActivityLabel(iter: IterationProgress, theme: any): string {
	if (iter.status === "pending") return "";
	if (iter.status === "done") {
		const preview = iter.lastText?.slice(0, 60);
		return preview ? theme.fg("dim", truncate(preview, 60)) : "";
	}
	if (iter.status === "failed") {
		return iter.error ? theme.fg("error", truncate(iter.error, 60)) : "";
	}

	// Running
	if (iter.lastToolCall) {
		return theme.fg("muted", `→ ${iter.lastToolCall}`);
	}
	return theme.fg("dim", "thinking...");
}

function formatToolDetail(iter: IterationProgress, theme: any): string | null {
	if (!iter.lastToolCall) return null;

	// Show the most recent tool and any file path from it
	const toolName = iter.lastToolCall;
	const lastMsg = iter.messages[iter.messages.length - 1];

	if (lastMsg && lastMsg.role === "assistant") {
		for (const part of lastMsg.content) {
			if (part.type === "toolCall" && part.name === toolName) {
				const args = part.arguments as Record<string, any>;
				const filePath = args?.path || args?.file_path || args?.command;
				if (filePath) {
					const detail = typeof filePath === "string" ? truncate(filePath, 50) : "";
					return theme.fg("dim", detail);
				}
			}
		}
	}

	return null;
}

function truncate(str: string, max: number): string {
	const clean = str.replace(/\n/g, " ").trim();
	return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${minutes}m${secs}s`;
}
