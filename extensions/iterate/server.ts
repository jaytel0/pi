/**
 * Dev server management for iterate extension
 *
 * Handles port probing, process lifecycle, health checks,
 * and browser opening for iteration dev servers.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";

export interface DevServer {
	index: number;
	proc: ChildProcess;
	port: number;
	url: string;
	status: "starting" | "ready" | "failed" | "stopped";
	stdout: string;
	stderr: string;
}

const HEALTH_CHECK_INTERVAL = 1000;
const HEALTH_CHECK_TIMEOUT = 30000; // 30s to wait for server to be ready
const PORT_RANGE_START = 3001;
const PORT_RANGE_END = 3099;

/**
 * Find N available ports starting from a base.
 */
export async function findAvailablePorts(count: number, start = PORT_RANGE_START): Promise<number[]> {
	const ports: number[] = [];
	let candidate = start;

	while (ports.length < count && candidate <= PORT_RANGE_END) {
		const available = await isPortAvailable(candidate);
		if (available) {
			ports.push(candidate);
		}
		candidate++;
	}

	if (ports.length < count) {
		// Fall back to random available ports
		for (let i = ports.length; i < count; i++) {
			const port = await getRandomPort();
			ports.push(port);
		}
	}

	return ports;
}

function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close(() => resolve(true));
		});
		server.listen(port, "127.0.0.1");
	});
}

function getRandomPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error("Could not get port")));
			}
		});
	});
}

/**
 * Wait for a port to accept connections (health check).
 */
export function waitForPort(port: number, timeoutMs = HEALTH_CHECK_TIMEOUT): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;

		const check = () => {
			if (Date.now() > deadline) {
				resolve(false);
				return;
			}

			const socket = new net.Socket();
			socket.setTimeout(500);

			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});

			socket.once("error", () => {
				socket.destroy();
				setTimeout(check, HEALTH_CHECK_INTERVAL);
			});

			socket.once("timeout", () => {
				socket.destroy();
				setTimeout(check, HEALTH_CHECK_INTERVAL);
			});

			socket.connect(port, "127.0.0.1");
		};

		check();
	});
}

/**
 * Start a dev server for a single worktree.
 */
export function startServer(
	cwd: string,
	command: string,
	port: number,
	index: number,
): DevServer {
	const proc = spawn("sh", ["-c", command], {
		cwd,
		env: { ...process.env, PORT: String(port), BROWSER: "none", FORCE_COLOR: "0" },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});

	const server: DevServer = {
		index,
		proc,
		port,
		url: `http://localhost:${port}`,
		status: "starting",
		stdout: "",
		stderr: "",
	};

	// Capture output (last 2KB)
	proc.stdout?.on("data", (data: Buffer) => {
		server.stdout = (server.stdout + data.toString()).slice(-2048);
		// Detect common "ready" patterns
		if (isReadyMessage(server.stdout)) {
			server.status = "ready";
		}
	});

	proc.stderr?.on("data", (data: Buffer) => {
		server.stderr = (server.stderr + data.toString()).slice(-2048);
		if (isReadyMessage(server.stderr)) {
			server.status = "ready";
		}
	});

	proc.on("close", (code) => {
		if (server.status !== "stopped") {
			server.status = code === 0 ? "stopped" : "failed";
		}
	});

	proc.on("error", () => {
		server.status = "failed";
	});

	proc.unref();

	return server;
}

/**
 * Check if server output indicates it's ready.
 */
function isReadyMessage(output: string): boolean {
	const lower = output.toLowerCase();
	const readyPatterns = [
		"ready in",           // Vite
		"compiled successfully", // Webpack/CRA
		"started server on",  // Next.js
		"listening on",       // Generic
		"server running",     // Generic
		"local:",             // Vite
		"localhost:",         // Many
		"ready on",           // Various
		"serving!",           // Serve
		"compiled client",    // Next.js
	];
	return readyPatterns.some((p) => lower.includes(p));
}

/**
 * Stop a dev server.
 */
export function stopServer(server: DevServer): void {
	server.status = "stopped";
	try {
		if (server.proc.pid) {
			// Kill the process group
			process.kill(-server.proc.pid, "SIGTERM");
			// Force kill after 3s
			setTimeout(() => {
				try {
					if (server.proc.pid) process.kill(-server.proc.pid, "SIGKILL");
				} catch { /* already dead */ }
			}, 3000);
		}
	} catch {
		try {
			server.proc.kill("SIGKILL");
		} catch { /* already dead */ }
	}
}

/**
 * Open URLs in the default browser.
 */
export function openInBrowser(urls: string[]): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	for (const url of urls) {
		try {
			execSync(`${cmd} "${url}"`, { stdio: "ignore" });
		} catch {
			// Browser open is best-effort
		}
	}
}

/**
 * Detect the dev command and package manager for a project.
 */
export function detectProjectDevInfo(repoRoot: string): {
	packageManager: string;
	devScript: string | null;
	defaultCommand: string | null;
} {
	const pm = detectPackageManager(repoRoot);
	const pkgPath = path.join(repoRoot, "package.json");

	let devScript: string | null = null;
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		const scripts = pkg.scripts || {};
		if (scripts.dev) devScript = "dev";
		else if (scripts.start) devScript = "start";
		else if (scripts.serve) devScript = "serve";
	} catch {}

	return {
		packageManager: pm,
		devScript,
		defaultCommand: devScript ? `${pm} run ${devScript}` : null,
	};
}

function detectPackageManager(repoRoot: string): string {
	if (fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) return "yarn";
	if (fs.existsSync(path.join(repoRoot, "bun.lockb"))) return "bun";
	return "npm";
}
