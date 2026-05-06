/**
 * Pi Iterate Extension — Parallel Agent Orchestration
 *
 * /iterate          - Launch N parallel iterations from current HEAD
 * /iterate-status   - Check progress of running/completed iterations
 * /iterate-pick     - Choose a winner and merge back (merge, cherry-pick, or keep branches)
 * /iterate-serve    - Start dev servers with port probing + health checks + auto-open
 * /iterate-diff     - Compare iterations (stat, full diff, inter-diff)
 * /iterate-cleanup  - Remove all worktrees and branches
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Text, Markdown } from "@mariozechner/pi-tui";
import {
	type IterationSession,
	getRepoRoot,
	isDirty,
	stashChanges,
	stashPop,
	createWorktrees,
	saveSessionMeta,
	cleanupSession,
	mergeWinner,
	cherryPickCommits,
	getDiffStat,
	getFullDiff,
	getInterDiff,
	listIterationCommits,
	listSessions,
} from "./worktree.js";
import {
	type IterationProgress,
	type RunResult,
	runIterations,
	getFinalOutput,
	countToolCalls,
} from "./runner.js";
import {
	setWidgetPhase,
	updateIterationProgress,
	clearWidget,
} from "./widget.js";
import {
	type DevServer,
	findAvailablePorts,
	waitForPort,
	startServer,
	stopServer,
	openInBrowser,
	detectProjectDevInfo,
} from "./server.js";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── In-memory state ───
let activeSession: IterationSession | null = null;
let lastResult: RunResult | null = null;
let devServers: Map<number, DevServer> = new Map();

export default function (pi: ExtensionAPI) {

	// ─── Restore state on session start ───
	pi.on("session_start", async (_event, ctx) => {
		const repoRoot = getRepoRoot(ctx.cwd);
		if (!repoRoot) return;

		const sessions = listSessions(ctx.cwd);
		if (sessions.length > 0) {
			activeSession = sessions[0];
			setWidgetPhase(ctx, "done", {
				sessionId: activeSession.id,
				baseBranch: activeSession.baseBranch,
				iterations: activeSession.worktrees.map((wt) => ({
					index: wt.index,
					branch: wt.branch,
					status: "done" as const,
					turns: 0,
					filesModified: [],
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				})),
			});
		}
	});

	// ─── Cleanup on shutdown ───
	pi.on("session_shutdown", async () => {
		stopAllServers();
	});

	// ═══════════════════════════════════════════════════
	// Message renderers
	// ═══════════════════════════════════════════════════

	pi.registerMessageRenderer("iterate-summary", (message, { expanded }, theme) => {
		const mdTheme = getMarkdownTheme();
		if (expanded) {
			return new Markdown(message.content, 0, 0, mdTheme);
		}
		const details = message.details as any;
		const count = details?.iterationCount || "?";
		const cost = details?.totalCost ? `$${details.totalCost.toFixed(4)}` : "";
		const elapsed = details?.elapsed ? formatElapsed(details.elapsed) : "";
		const text = theme.fg("accent", `🔀 Iteration results (${count} iterations)`) +
			(cost ? theme.fg("dim", ` ${cost}`) : "") +
			(elapsed ? theme.fg("dim", ` ${elapsed}`) : "") +
			theme.fg("dim", " — expand for details");
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer("iterate-merged", (message, _options, theme) => {
		return new Text(theme.fg("success", message.content), 0, 0);
	});

	pi.registerMessageRenderer("iterate-servers", (message, _options, theme) => {
		const lines = message.content.split("\n");
		const container = new Container();
		for (const line of lines) {
			const urlMatch = line.match(/(https?:\/\/localhost:\d+)/);
			if (urlMatch) {
				container.addChild(new Text(
					theme.fg("muted", line.replace(urlMatch[1], "")) + theme.fg("accent", theme.bold(urlMatch[1])),
					0, 0,
				));
			} else {
				container.addChild(new Text(theme.fg("dim", line), 0, 0));
			}
		}
		return container;
	});

	pi.registerMessageRenderer("iterate-diff", (message, { expanded }, theme) => {
		if (!expanded) {
			return new Text(theme.fg("accent", "🔀 Iteration comparison") + theme.fg("dim", " — expand for details"), 0, 0);
		}
		const mdTheme = getMarkdownTheme();
		return new Markdown(message.content, 0, 0, mdTheme);
	});

	// ═══════════════════════════════════════════════════
	// /iterate — Main command
	// ═══════════════════════════════════════════════════

	pi.registerCommand("iterate", {
		description: "Launch N parallel agent iterations from current HEAD",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const repoRoot = getRepoRoot(ctx.cwd);
			if (!repoRoot) {
				ctx.ui.notify("Not in a git repository", "error");
				return;
			}

			// Check for existing session
			if (activeSession) {
				const ok = await ctx.ui.confirm(
					"Active iteration session",
					`Session ${activeSession.id} with ${activeSession.worktrees.length} worktrees exists.\nClean it up and start fresh?`,
				);
				if (!ok) return;
				cleanupSessionFull(ctx);
			}

			// Handle dirty working tree
			let didStash = false;
			if (isDirty(repoRoot)) {
				const choice = await ctx.ui.select("Working tree has uncommitted changes", [
					"Stash changes and continue",
					"Cancel",
				]);
				if (choice === undefined || choice === "Cancel") return;
				didStash = stashChanges(repoRoot);
				if (!didStash) {
					ctx.ui.notify("Failed to stash changes", "error");
					return;
				}
				ctx.ui.notify("Changes stashed", "info");
			}

			// Get iteration count
			const countStr = args?.trim() || (await ctx.ui.input("How many iterations?", "3"));
			if (!countStr) return;
			const count = parseInt(countStr, 10);
			if (isNaN(count) || count < 2 || count > 8) {
				ctx.ui.notify("Need between 2 and 8 iterations", "error");
				if (didStash) stashPop(repoRoot);
				return;
			}

			// Get prompt mode
			const promptMode = await ctx.ui.select("Prompt mode", [
				"Same prompt → all iterations get identical instructions",
				"Base + twist → shared base prompt with per-iteration variations",
				"Fully different → write a separate prompt for each iteration",
			]);
			if (promptMode === undefined) {
				if (didStash) stashPop(repoRoot);
				return;
			}

			// Collect prompts
			let prompts: string[];

			if (promptMode.startsWith("Same")) {
				const prompt = await ctx.ui.editor("Enter the prompt for all iterations:", "");
				if (!prompt?.trim()) { if (didStash) stashPop(repoRoot); return; }
				prompts = Array(count).fill(prompt);

			} else if (promptMode.startsWith("Base")) {
				const base = await ctx.ui.editor("Enter the BASE prompt (shared across all iterations):", "");
				if (!base?.trim()) { if (didStash) stashPop(repoRoot); return; }

				prompts = [];
				for (let i = 1; i <= count; i++) {
					const twist = await ctx.ui.editor(
						`Variation for iteration ${i}/${count} (appended to base prompt):`,
						i === 1 ? "Approach: " : extractTwist(prompts[prompts.length - 1], base),
					);
					if (!twist?.trim()) { if (didStash) stashPop(repoRoot); return; }
					prompts.push(`${base}\n\n---\nVariation for this iteration:\n${twist}`);
				}

			} else {
				prompts = [];
				for (let i = 1; i <= count; i++) {
					const prompt = await ctx.ui.editor(
						`Enter prompt for iteration ${i}/${count}:`,
						i > 1 ? prompts[prompts.length - 1] : "",
					);
					if (!prompt?.trim()) { if (didStash) stashPop(repoRoot); return; }
					prompts.push(prompt);
				}
			}

			// ─── Create worktrees ───
			setWidgetPhase(ctx, "creating", { baseBranch: "" });
			let session: IterationSession;
			try {
				session = createWorktrees(ctx.cwd, repoRoot, count);
				saveSessionMeta(session);
				activeSession = session;
			} catch (e: any) {
				ctx.ui.notify(`Failed to create worktrees: ${e.message}`, "error");
				clearWidget(ctx);
				if (didStash) stashPop(repoRoot);
				return;
			}

			setWidgetPhase(ctx, "creating", { sessionId: session.id, baseBranch: session.baseBranch });
			ctx.ui.notify(`Created ${count} worktrees from ${session.baseBranch} (${session.baseCommit.slice(0, 7)})`, "info");

			// ─── Install dependencies ───
			const hasPackageJson = fs.existsSync(path.join(repoRoot, "package.json"));
			if (hasPackageJson) {
				setWidgetPhase(ctx, "installing");
				await installDepsInWorktrees(session);
			}

			// ─── Run iterations ───
			const startTime = Date.now();
			setWidgetPhase(ctx, "running", { startTime });

			const configs = session.worktrees.map((wt, i) => ({
				index: wt.index,
				cwd: wt.directory,
				prompt: prompts[i],
				branch: wt.branch,
			}));

			const result = await runIterations(configs, undefined, (progress) => {
				updateIterationProgress(ctx, progress);
			});

			lastResult = result;
			setWidgetPhase(ctx, "done", { iterations: result.iterations, startTime });

			// ─── Summary ───
			const summary = buildSummaryMarkdown(session, result);
			pi.sendMessage({
				customType: "iterate-summary",
				content: summary,
				display: true,
				details: {
					iterationCount: count,
					totalCost: result.totalCost,
					elapsed: result.elapsed,
					sessionId: session.id,
				},
			});
		},
	});

	// ═══════════════════════════════════════════════════
	// /iterate-status
	// ═══════════════════════════════════════════════════

	pi.registerCommand("iterate-status", {
		description: "Show status of current iteration session",
		handler: async (_args, ctx) => {
			if (!activeSession) { ctx.ui.notify("No active iteration session", "info"); return; }

			const s = activeSession;
			let msg = `**Session:** ${s.id}\n`;
			msg += `**Base:** ${s.baseBranch} @ ${s.baseCommit.slice(0, 7)}\n`;
			msg += `**Worktrees:** ${s.worktrees.length}\n\n`;

			for (const wt of s.worktrees) {
				const exists = fs.existsSync(wt.directory);
				msg += `- \`${wt.branch}\` → \`${wt.directory}\` ${exists ? "✅" : "❌ missing"}\n`;
			}

			if (lastResult) {
				msg += `\n**Results:**\n`;
				for (const iter of lastResult.iterations) {
					const icon = iter.status === "done" ? "✅" : "❌";
					const tools = countToolCalls(iter.messages);
					const toolSummary = Object.entries(tools).map(([n, c]) => `${n}×${c}`).join(", ");
					msg += `- ${icon} #${iter.index}: ${iter.turns} turns, ${iter.filesModified.length} files, ${toolSummary || "no tools"}, $${iter.usage.cost.toFixed(4)}\n`;
				}
				msg += `\n**Total cost:** $${lastResult.totalCost.toFixed(4)} in ${formatElapsed(lastResult.elapsed)}`;
			}

			if (devServers.size > 0) {
				msg += `\n\n**Dev servers:**\n`;
				for (const [idx, server] of devServers) {
					const statusIcon = server.status === "ready" ? "🟢" : server.status === "starting" ? "🟡" : "🔴";
					msg += `- ${statusIcon} #${idx}: ${server.url} (${server.status})\n`;
				}
			}

			if (s.keepBranches && s.keepBranches.length > 0) {
				msg += `\n\n**Kept branches:** ${s.keepBranches.map((b) => `\`${b}\``).join(", ")}\n`;
			}

			pi.sendMessage({ customType: "iterate-diff", content: msg, display: true });
		},
	});

	// ═══════════════════════════════════════════════════
	// /iterate-pick — Phase 4: merge, cherry-pick, or keep
	// ═══════════════════════════════════════════════════

	pi.registerCommand("iterate-pick", {
		description: "Choose a winning iteration — merge, cherry-pick, or keep branches",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (!activeSession) { ctx.ui.notify("No active iteration session", "error"); return; }

			// ─── Step 1: Pick the winner ───
			const options: string[] = [];
			for (const wt of activeSession.worktrees) {
				const iter = lastResult?.iterations.find((i) => i.index === wt.index);
				let label = `#${wt.index}`;
				if (iter) {
					const icon = iter.status === "done" ? "✓" : "✗";
					label += ` ${icon} — ${iter.turns} turns, ${iter.filesModified.length} files, $${iter.usage.cost.toFixed(4)}`;
				}
				options.push(label);
			}
			options.push("Cancel");

			const choice = await ctx.ui.select("Pick the winning iteration:", options);
			if (!choice || choice === "Cancel") return;

			const winnerIndex = parseInt(choice.match(/#(\d+)/)?.[1] || "0", 10);
			if (!winnerIndex) return;

			// ─── Step 2: Choose consolidation strategy ───
			const strategy = await ctx.ui.select("How to consolidate?", [
				"Merge — merge entire branch into " + activeSession.baseBranch,
				"Cherry-pick — select specific commits to apply",
				"Keep branch — just keep the branch, don't merge yet",
			]);
			if (!strategy) return;

			if (strategy.startsWith("Keep")) {
				// Just mark the branch as kept
				const winner = activeSession.worktrees.find((w) => w.index === winnerIndex);
				if (winner) {
					if (!activeSession.keepBranches) activeSession.keepBranches = [];
					activeSession.keepBranches.push(winner.branch);
					saveSessionMeta(activeSession);
					ctx.ui.notify(`Branch ${winner.branch} will be kept on cleanup`, "info");
				}

				// Ask about runner-ups
				await handleRunnerUps(ctx);
				return;
			}

			if (strategy.startsWith("Cherry-pick")) {
				// ─── Cherry-pick flow ───
				const commits = listIterationCommits(activeSession, winnerIndex);
				if (commits.length === 0) {
					ctx.ui.notify("No commits found on this iteration branch", "error");
					return;
				}

				const commitOptions = commits.map((c) => `${c.sha} ${c.message}`);
				commitOptions.push("All commits");
				commitOptions.push("Cancel");

				// Let user multi-select (for now, select one at a time or all)
				const commitChoice = await ctx.ui.select(
					`Pick commits from iteration ${winnerIndex} (${commits.length} available):`,
					commitOptions,
				);
				if (!commitChoice || commitChoice === "Cancel") return;

				let selectedShas: string[];
				if (commitChoice === "All commits") {
					selectedShas = commits.map((c) => c.sha).reverse(); // oldest first
				} else {
					const sha = commitChoice.split(" ")[0];
					selectedShas = [sha];
				}

				const confirmMsg = `Cherry-pick ${selectedShas.length} commit(s) onto ${activeSession.baseBranch}?`;
				const confirm = await ctx.ui.confirm("Cherry-pick?", confirmMsg);
				if (!confirm) return;

				stopAllServers();
				ctx.ui.setStatus("iterate", "🔀 Cherry-picking...");

				const cpResult = cherryPickCommits(activeSession, winnerIndex, selectedShas);
				if (!cpResult.success) {
					ctx.ui.notify(`Cherry-pick failed after ${cpResult.applied.length} commits: ${cpResult.error}`, "error");
					return;
				}

				ctx.ui.notify(`Cherry-picked ${cpResult.applied.length} commit(s) onto ${activeSession.baseBranch}`, "info");

				// Ask about runner-ups before cleanup
				await handleRunnerUps(ctx);

				pi.sendMessage({
					customType: "iterate-merged",
					content: `✅ Cherry-picked ${cpResult.applied.length} commit(s) from iteration ${winnerIndex} onto \`${activeSession.baseBranch}\`.`,
					display: true,
				});
				return;
			}

			// ─── Full merge flow ───
			// Show diff stat for confirmation
			const stat = getDiffStat(activeSession, winnerIndex);
			const winnerIter = lastResult?.iterations.find((i) => i.index === winnerIndex);
			let confirmMsg = `Merge iteration ${winnerIndex} into ${activeSession.baseBranch}?\n\n`;
			if (stat) confirmMsg += `${stat}\n\n`;
			if (winnerIter && winnerIter.filesModified.length > 0) {
				confirmMsg += `Files modified:\n${winnerIter.filesModified.map((f) => `  ${f}`).join("\n")}\n\n`;
			}

			const confirm = await ctx.ui.confirm("Merge winner?", confirmMsg);
			if (!confirm) return;

			// Ask about runner-ups before cleanup
			await handleRunnerUps(ctx);

			stopAllServers();
			ctx.ui.setStatus("iterate", "🔀 Merging winner...");

			const mergeResult = mergeWinner(activeSession, winnerIndex);
			if (!mergeResult.success) {
				ctx.ui.notify(`Merge failed: ${mergeResult.error}`, "error");
				return;
			}

			const baseBranch = activeSession.baseBranch;
			ctx.ui.notify(`Merged iteration ${winnerIndex} into ${baseBranch}`, "info");

			// Cleanup (respects keepBranches)
			cleanupSessionFull(ctx);

			pi.sendMessage({
				customType: "iterate-merged",
				content: `✅ Iteration ${winnerIndex} merged into \`${baseBranch}\`. Worktrees cleaned up.`,
				display: true,
			});
		},
	});

	// ═══════════════════════════════════════════════════
	// /iterate-serve — Phase 3: smart dev servers
	// ═══════════════════════════════════════════════════

	pi.registerCommand("iterate-serve", {
		description: "Start dev servers for all iterations with health checks",
		handler: async (args, ctx) => {
			if (!activeSession) { ctx.ui.notify("No active iteration session", "error"); return; }

			const { defaultCommand } = detectProjectDevInfo(activeSession.repoRoot);

			// Get dev command
			let devCmd: string | null;
			if (defaultCommand) {
				devCmd = await ctx.ui.input("Dev server command:", defaultCommand);
			} else {
				devCmd = await ctx.ui.input("Dev server command (e.g., 'pnpm dev'):", "");
			}
			if (!devCmd) return;

			// Stop existing servers
			stopAllServers();

			// Find available ports
			ctx.ui.setStatus("iterate", "🔀 Finding available ports...");
			const ports = await findAvailablePorts(activeSession.worktrees.length);

			// Start servers
			ctx.ui.setStatus("iterate", "🔀 Starting dev servers...");
			for (let i = 0; i < activeSession.worktrees.length; i++) {
				const wt = activeSession.worktrees[i];
				const port = ports[i];
				const server = startServer(wt.directory, devCmd, port, wt.index);
				devServers.set(wt.index, server);
			}

			// Wait for health checks
			ctx.ui.setStatus("iterate", "🔀 Waiting for servers to be ready...");
			const healthResults = await Promise.all(
				Array.from(devServers.values()).map(async (server) => {
					const ready = await waitForPort(server.port);
					if (ready) server.status = "ready";
					else if (server.status === "starting") server.status = "failed";
					return { index: server.index, ready, url: server.url, status: server.status };
				}),
			);

			const readyCount = healthResults.filter((r) => r.ready).length;
			const readyUrls = healthResults.filter((r) => r.ready).map((r) => r.url);

			// Build message
			const lines: string[] = [`Dev servers: ${readyCount}/${healthResults.length} ready`, ""];
			for (const r of healthResults) {
				const icon = r.ready ? "🟢" : "🔴";
				lines.push(`  ${icon} Iteration ${r.index}: ${r.url} (${r.status})`);
			}

			// Check for failed servers and show stderr
			for (const r of healthResults) {
				if (!r.ready) {
					const server = devServers.get(r.index);
					if (server?.stderr) {
						lines.push(`\n  ⚠️ #${r.index} stderr: ${server.stderr.slice(-200)}`);
					}
				}
			}

			lines.push("", "Review each iteration, then /iterate-pick to choose a winner.");

			pi.sendMessage({ customType: "iterate-servers", content: lines.join("\n"), display: true });

			// Auto-open in browser
			if (readyUrls.length > 0) {
				const shouldOpen = await ctx.ui.confirm("Open in browser?", `Open ${readyUrls.length} URL(s) in your browser?`);
				if (shouldOpen) {
					openInBrowser(readyUrls);
				}
			}

			ctx.ui.setStatus("iterate", `🔀 ${readyCount}/${healthResults.length} servers ready — /iterate-pick to choose winner`);
		},
	});

	// ═══════════════════════════════════════════════════
	// /iterate-diff — Phase 4: rich diff viewer
	// ═══════════════════════════════════════════════════

	pi.registerCommand("iterate-diff", {
		description: "Compare iterations — stat, full diff, or cross-diff",
		handler: async (_args, ctx) => {
			if (!activeSession || !lastResult) { ctx.ui.notify("No completed iteration session", "error"); return; }

			const diffMode = await ctx.ui.select("Diff mode", [
				"Summary — stat overview of all iterations vs base",
				"Full diff — complete diff of one iteration vs base",
				"Cross-diff — diff between two iterations",
			]);
			if (!diffMode) return;

			if (diffMode.startsWith("Summary")) {
				let md = `## Iteration Diff Summary\n\n`;
				md += `**Base:** \`${activeSession.baseBranch}\` @ \`${activeSession.baseCommit.slice(0, 7)}\`\n\n`;

				for (const iter of lastResult.iterations) {
					const icon = iter.status === "done" ? "✅" : "❌";
					const tools = countToolCalls(iter.messages);
					const toolSummary = Object.entries(tools).map(([n, c]) => `${n}×${c}`).join(", ");

					md += `### ${icon} Iteration ${iter.index}\n`;
					md += `- **Turns:** ${iter.turns} | **Cost:** $${iter.usage.cost.toFixed(4)} | **Tools:** ${toolSummary || "—"}\n`;

					const stat = getDiffStat(activeSession, iter.index);
					if (stat) {
						md += `\n\`\`\`\n${stat}\n\`\`\`\n\n`;
					}

					const output = getFinalOutput(iter.messages);
					if (output) {
						md += `**Agent summary:** ${output.length > 300 ? output.slice(0, 300) + "..." : output}\n\n`;
					}
				}

				pi.sendMessage({ customType: "iterate-diff", content: md, display: true });

			} else if (diffMode.startsWith("Full diff")) {
				const iterOptions = activeSession.worktrees.map((wt) => `Iteration ${wt.index} (${wt.branch})`);
				const iterChoice = await ctx.ui.select("Which iteration?", iterOptions);
				if (!iterChoice) return;

				const idx = parseInt(iterChoice.match(/Iteration (\d+)/)?.[1] || "0", 10);
				if (!idx) return;

				const diff = getFullDiff(activeSession, idx);
				const commits = listIterationCommits(activeSession, idx);

				let md = `## Full Diff: Iteration ${idx} vs ${activeSession.baseBranch}\n\n`;
				if (commits.length > 0) {
					md += `**Commits (${commits.length}):**\n`;
					for (const c of commits) {
						md += `- \`${c.sha}\` ${c.message}\n`;
					}
					md += "\n";
				}
				md += `\`\`\`diff\n${diff}\n\`\`\`\n`;

				pi.sendMessage({ customType: "iterate-diff", content: md, display: true });

			} else {
				// Cross-diff
				const iterOptions = activeSession.worktrees.map((wt) => `Iteration ${wt.index} (${wt.branch})`);

				const iterA = await ctx.ui.select("First iteration:", iterOptions);
				if (!iterA) return;
				const idxA = parseInt(iterA.match(/Iteration (\d+)/)?.[1] || "0", 10);

				const iterB = await ctx.ui.select("Second iteration:", iterOptions.filter((o) => !o.startsWith(`Iteration ${idxA}`)));
				if (!iterB) return;
				const idxB = parseInt(iterB.match(/Iteration (\d+)/)?.[1] || "0", 10);

				const diff = getInterDiff(activeSession, idxA, idxB);

				let md = `## Cross-Diff: Iteration ${idxA} → Iteration ${idxB}\n\n`;
				md += `\`\`\`diff\n${diff}\n\`\`\`\n`;

				pi.sendMessage({ customType: "iterate-diff", content: md, display: true });
			}
		},
	});

	// ═══════════════════════════════════════════════════
	// /iterate-cleanup
	// ═══════════════════════════════════════════════════

	pi.registerCommand("iterate-cleanup", {
		description: "Remove all iteration worktrees and branches",
		handler: async (_args, ctx) => {
			if (!activeSession) { ctx.ui.notify("No active iteration session", "info"); return; }

			let msg = `Remove ${activeSession.worktrees.length} worktrees?`;
			if (activeSession.keepBranches && activeSession.keepBranches.length > 0) {
				msg += `\n\nKept branches will be preserved:\n${activeSession.keepBranches.map((b) => `  ${b}`).join("\n")}`;
			}
			msg += "\n\nThis cannot be undone.";

			const confirm = await ctx.ui.confirm("Cleanup iterations?", msg);
			if (!confirm) return;

			const result = cleanupSessionFull(ctx);
			if (result.kept.length > 0) {
				ctx.ui.notify(`Cleaned up. Kept branches: ${result.kept.join(", ")}`, "info");
			} else {
				ctx.ui.notify("All iteration worktrees and branches removed", "info");
			}
		},
	});

	// ═══════════════════════════════════════════════════
	// Helpers
	// ═══════════════════════════════════════════════════

	/**
	 * Ask user if they want to keep any runner-up branches.
	 */
	async function handleRunnerUps(ctx: ExtensionCommandContext) {
		if (!activeSession || activeSession.worktrees.length <= 1) return;

		const keepChoice = await ctx.ui.select("Keep any runner-up branches?", [
			"No — delete all other branches on cleanup",
			"Yes — choose branches to keep",
		]);

		if (keepChoice?.startsWith("Yes")) {
			if (!activeSession.keepBranches) activeSession.keepBranches = [];

			for (const wt of activeSession.worktrees) {
				if (activeSession.keepBranches.includes(wt.branch)) continue;
				const keep = await ctx.ui.confirm(
					`Keep ${wt.branch}?`,
					`Keep iteration ${wt.index} branch for later reference?`,
				);
				if (keep) {
					activeSession.keepBranches.push(wt.branch);
				}
			}

			saveSessionMeta(activeSession);

			if (activeSession.keepBranches.length > 0) {
				ctx.ui.notify(`Will keep: ${activeSession.keepBranches.join(", ")}`, "info");
			}
		}
	}

	function cleanupSessionFull(ctx: ExtensionContext | ExtensionCommandContext): { kept: string[]; errors: string[] } {
		stopAllServers();
		let kept: string[] = [];
		let errors: string[] = [];
		if (activeSession) {
			const result = cleanupSession(activeSession);
			kept = result.kept;
			errors = result.errors;
			if (errors.length > 0) {
				ctx.ui.notify(`Cleanup had errors: ${errors.join("; ")}`, "warning");
			}
		}
		activeSession = null;
		lastResult = null;
		clearWidget(ctx);
		return { kept, errors };
	}

	function stopAllServers() {
		for (const [_idx, server] of devServers) {
			stopServer(server);
		}
		devServers.clear();
	}
}

// ═══════════════════════════════════════════════════
// Standalone helpers
// ═══════════════════════════════════════════════════

function buildSummaryMarkdown(session: IterationSession, result: RunResult): string {
	const succeeded = result.iterations.filter((i) => i.status === "done").length;
	const failed = result.iterations.filter((i) => i.status === "failed").length;

	let md = `## 🔀 Iteration Results\n\n`;
	md += `**Session:** ${session.id} | **Branch:** ${session.baseBranch} @ ${session.baseCommit.slice(0, 7)}\n`;
	md += `**Time:** ${formatElapsed(result.elapsed)} | **Total cost:** $${result.totalCost.toFixed(4)} | **${succeeded}** succeeded`;
	if (failed > 0) md += ` | **${failed}** failed`;
	md += `\n\n`;

	for (const iter of result.iterations) {
		const icon = iter.status === "done" ? "✅" : "❌";
		const tools = countToolCalls(iter.messages);
		const toolSummary = Object.entries(tools).map(([n, c]) => `${n}×${c}`).join(", ");

		md += `### ${icon} Iteration ${iter.index}\n`;
		md += `| Turns | Files | Tools | Cost |\n`;
		md += `|-------|-------|-------|------|\n`;
		md += `| ${iter.turns} | ${iter.filesModified.length} modified | ${toolSummary || "—"} | $${iter.usage.cost.toFixed(4)} |\n\n`;

		if (iter.filesModified.length > 0) {
			md += `**Files:** ${iter.filesModified.map((f) => `\`${f}\``).join(", ")}\n\n`;
		}

		const output = getFinalOutput(iter.messages);
		if (output) {
			const preview = output.length > 300 ? output.slice(0, 300) + "..." : output;
			md += `${preview}\n\n`;
		}

		if (iter.error) md += `> ⚠️ ${iter.error}\n\n`;
		md += `📁 \`${session.worktrees[iter.index - 1].directory}\`\n\n`;
	}

	md += `---\n`;
	md += `**Next:** \`/iterate-serve\` to preview | \`/iterate-diff\` to compare | \`/iterate-pick\` to choose winner\n`;
	return md;
}

function extractTwist(previousFull: string, _base: string): string {
	const marker = "Variation for this iteration:\n";
	const idx = previousFull.indexOf(marker);
	if (idx >= 0) return previousFull.slice(idx + marker.length);
	return "Approach: ";
}

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${minutes}m${secs}s`;
}

async function installDepsInWorktrees(session: IterationSession): Promise<void> {
	const { packageManager } = detectProjectDevInfo(session.repoRoot);
	const installs = session.worktrees.map(
		(wt) =>
			new Promise<void>((resolve) => {
				const proc = spawn(packageManager, ["install"], {
					cwd: wt.directory,
					stdio: ["ignore", "pipe", "pipe"],
				});
				proc.on("close", () => resolve());
				proc.on("error", () => resolve());
			}),
	);
	await Promise.all(installs);
}
