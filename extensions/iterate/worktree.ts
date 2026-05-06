/**
 * Git worktree management for iterate extension
 *
 * Creates/removes worktrees in .pi-iterations/ directory.
 * Each iteration gets its own branch and working directory.
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface IterationWorktree {
	index: number;
	branch: string;
	directory: string;
}

export interface IterationSession {
	id: string;
	timestamp: number;
	repoRoot: string;
	baseBranch: string;
	baseCommit: string;
	iterationsDir: string;
	worktrees: IterationWorktree[];
	/** Branches to keep after cleanup (runner-ups) */
	keepBranches?: string[];
}

const ITERATIONS_DIR = ".pi-iterations";
const BRANCH_PREFIX = "pi-iter";

function git(args: string, opts?: ExecSyncOptions): string {
	return execSync(`git ${args}`, {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		...opts,
	}).trim();
}

export function getRepoRoot(cwd: string): string | null {
	try {
		return git("rev-parse --show-toplevel", { cwd });
	} catch {
		return null;
	}
}

export function getCurrentBranch(cwd: string): string {
	try {
		return git("rev-parse --abbrev-ref HEAD", { cwd });
	} catch {
		return git("rev-parse --short HEAD", { cwd });
	}
}

export function getHeadCommit(cwd: string): string {
	return git("rev-parse HEAD", { cwd });
}

export function isDirty(cwd: string): boolean {
	const status = git("status --porcelain", { cwd });
	return status.length > 0;
}

export function stashChanges(cwd: string): boolean {
	const before = git("stash list", { cwd });
	git("stash push -m 'pi-iterate: auto-stash before iteration'", { cwd });
	const after = git("stash list", { cwd });
	return before !== after;
}

export function stashPop(cwd: string): void {
	try {
		git("stash pop", { cwd });
	} catch {
		// stash pop can fail if there are conflicts — leave it in stash
	}
}

/**
 * Create N worktrees branching from the current HEAD.
 * @param cwd - The actual working directory pi is cd'd into (used as base for .pi-iterations)
 * @param repoRoot - The git repository root (used for git commands)
 */
export function createWorktrees(cwd: string, repoRoot: string, count: number): IterationSession {
	const sessionId = Date.now().toString(36);
	const baseBranch = getCurrentBranch(repoRoot);
	const baseCommit = getHeadCommit(repoRoot);
	const iterationsDir = path.join(cwd, ITERATIONS_DIR, sessionId);

	fs.mkdirSync(iterationsDir, { recursive: true });

	// Ensure .pi-iterations is gitignored
	ensureGitignore(repoRoot);

	const worktrees: IterationWorktree[] = [];

	for (let i = 1; i <= count; i++) {
		const branch = `${BRANCH_PREFIX}-${sessionId}-${i}`;
		const dir = path.join(iterationsDir, `iter-${i}`);

		git(`worktree add -b ${branch} "${dir}" HEAD`, { cwd: repoRoot });

		worktrees.push({ index: i, branch, directory: dir });
	}

	return {
		id: sessionId,
		timestamp: Date.now(),
		repoRoot,
		baseBranch,
		baseCommit,
		iterationsDir,
		worktrees,
		keepBranches: [],
	};
}

/**
 * Remove all worktrees and branches for a session.
 * Preserves branches listed in keepBranches.
 */
export function cleanupSession(session: IterationSession): { removed: number; kept: string[]; errors: string[] } {
	const errors: string[] = [];
	const kept: string[] = [];
	let removed = 0;
	const keepSet = new Set(session.keepBranches || []);

	for (const wt of session.worktrees) {
		// Always remove the worktree directory
		try {
			git(`worktree remove --force "${wt.directory}"`, { cwd: session.repoRoot });
			removed++;
		} catch (e: any) {
			errors.push(`worktree ${wt.directory}: ${e.message}`);
		}

		// Only delete the branch if it's not in the keep list
		if (keepSet.has(wt.branch)) {
			kept.push(wt.branch);
		} else {
			try {
				git(`branch -D ${wt.branch}`, { cwd: session.repoRoot });
			} catch {
				// Branch may already be gone
			}
		}
	}

	// Remove the session directory
	try {
		fs.rmSync(session.iterationsDir, { recursive: true, force: true });
	} catch {
		// May already be gone
	}

	// Remove parent .pi-iterations if empty
	const parentDir = path.dirname(session.iterationsDir);
	try {
		const entries = fs.readdirSync(parentDir);
		if (entries.length === 0) {
			fs.rmdirSync(parentDir);
		}
	} catch {
		// Ignore
	}

	return { removed, kept, errors };
}

/**
 * Merge a winning iteration branch into the base branch.
 */
export function mergeWinner(session: IterationSession, winnerIndex: number): { success: boolean; error?: string } {
	const winner = session.worktrees.find((w) => w.index === winnerIndex);
	if (!winner) return { success: false, error: `Iteration ${winnerIndex} not found` };

	try {
		const current = getCurrentBranch(session.repoRoot);
		if (current !== session.baseBranch) {
			git(`checkout ${session.baseBranch}`, { cwd: session.repoRoot });
		}

		git(`merge ${winner.branch} -m "Merge iteration ${winnerIndex} from pi-iterate session ${session.id}"`, {
			cwd: session.repoRoot,
		});

		return { success: true };
	} catch (e: any) {
		return { success: false, error: e.message };
	}
}

/**
 * Cherry-pick specific commits from an iteration branch onto the base branch.
 */
export function cherryPickCommits(
	session: IterationSession,
	winnerIndex: number,
	commitShas: string[],
): { success: boolean; applied: string[]; error?: string } {
	const winner = session.worktrees.find((w) => w.index === winnerIndex);
	if (!winner) return { success: false, applied: [], error: `Iteration ${winnerIndex} not found` };

	const applied: string[] = [];

	try {
		const current = getCurrentBranch(session.repoRoot);
		if (current !== session.baseBranch) {
			git(`checkout ${session.baseBranch}`, { cwd: session.repoRoot });
		}

		for (const sha of commitShas) {
			git(`cherry-pick ${sha}`, { cwd: session.repoRoot });
			applied.push(sha);
		}

		return { success: true, applied };
	} catch (e: any) {
		return { success: false, applied, error: e.message };
	}
}

/**
 * Get the diff stat between base commit and an iteration branch.
 */
export function getDiffStat(session: IterationSession, iterIndex: number): string {
	const wt = session.worktrees.find((w) => w.index === iterIndex);
	if (!wt) return "(not found)";

	try {
		return git(`diff --stat ${session.baseCommit}..${wt.branch}`, { cwd: session.repoRoot });
	} catch {
		return "(diff failed)";
	}
}

/**
 * Get the full diff between base commit and an iteration branch.
 */
export function getFullDiff(session: IterationSession, iterIndex: number): string {
	const wt = session.worktrees.find((w) => w.index === iterIndex);
	if (!wt) return "(not found)";

	try {
		return git(`diff ${session.baseCommit}..${wt.branch}`, { cwd: session.repoRoot });
	} catch {
		return "(diff failed)";
	}
}

/**
 * Get the diff between two iteration branches.
 */
export function getInterDiff(session: IterationSession, indexA: number, indexB: number): string {
	const wtA = session.worktrees.find((w) => w.index === indexA);
	const wtB = session.worktrees.find((w) => w.index === indexB);
	if (!wtA || !wtB) return "(not found)";

	try {
		return git(`diff ${wtA.branch}..${wtB.branch}`, { cwd: session.repoRoot });
	} catch {
		return "(diff failed)";
	}
}

/**
 * List commits on an iteration branch that are not on the base.
 */
export function listIterationCommits(session: IterationSession, iterIndex: number): { sha: string; message: string }[] {
	const wt = session.worktrees.find((w) => w.index === iterIndex);
	if (!wt) return [];

	try {
		const log = git(`log --oneline ${session.baseCommit}..${wt.branch}`, { cwd: session.repoRoot });
		if (!log) return [];
		return log.split("\n").map((line) => {
			const spaceIdx = line.indexOf(" ");
			return {
				sha: line.slice(0, spaceIdx),
				message: line.slice(spaceIdx + 1),
			};
		});
	} catch {
		return [];
	}
}

function ensureGitignore(repoRoot: string) {
	const gitignorePath = path.join(repoRoot, ".gitignore");
	const entry = ITERATIONS_DIR + "/";

	let content = "";
	try {
		content = fs.readFileSync(gitignorePath, "utf-8");
	} catch {
		// No .gitignore yet
	}

	if (!content.includes(entry)) {
		const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		fs.appendFileSync(gitignorePath, `${newline}${entry}\n`);
	}
}

/**
 * List existing iteration sessions by scanning .pi-iterations/
 * @param cwd - The actual working directory pi is cd'd into
 */
export function listSessions(cwd: string): IterationSession[] {
	const iterDir = path.join(cwd, ITERATIONS_DIR);
	if (!fs.existsSync(iterDir)) return [];

	const sessions: IterationSession[] = [];

	try {
		const entries = fs.readdirSync(iterDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const sessionDir = path.join(iterDir, entry.name);
			const metaPath = path.join(sessionDir, ".iterate-meta.json");

			if (fs.existsSync(metaPath)) {
				try {
					const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
					sessions.push(meta);
				} catch {
					// Corrupt meta, skip
				}
			}
		}
	} catch {
		// Can't read directory
	}

	return sessions.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Save session metadata to disk for persistence across Pi restarts.
 */
export function saveSessionMeta(session: IterationSession): void {
	const metaPath = path.join(session.iterationsDir, ".iterate-meta.json");
	fs.writeFileSync(metaPath, JSON.stringify(session, null, 2));
}
