/**
 * agent/runtime.ts — background agent runtime (storage + spawn + lifecycle).
 *
 * The one engine behind the `agent` tool family. A lean port of playground's
 * agent-runtime.ts + agent-runner.ts, stripped of the pieces that only fed the
 * /agents panel UI and deep nesting: observability, model aliases, tunable
 * ui-config, the subscription bus, the parent-linked run forest, MCP injection,
 * and detach-mid-flight. What remains is the fire-and-forget core: launch a
 * registry agent in a separate `pi` subprocess, persist its state to disk so it
 * can be reconciled after a soft /reload, and expose status / result / wait /
 * list / kill. Blocking delegation is just launch + wait; parallel/chain are the
 * model calling these primitives itself.
 *
 * Agent discovery is registry-backed (see agents.ts): a `pi/registry/*.md` file
 * is a callable agent when it has both `agent:` and `description:` frontmatter.
 *
 * Storage layout — <stateRoot>/pi-bg-runs/<runId>/
 *   meta.json     immutable launch metadata { agent, label, started }
 *   status        "running" | "done" | "failed" | "aborted"  (mutable; polled)
 *   turns         approximate assistant-turn count
 *   result        final assistant text (written on finish)
 *   exit          child exit code
 *   finished      end timestamp (written on finish; freezes elapsed)
 *   pid           spawned child pid (removed on finish)
 *   stream.jsonl  raw `pi --mode json` output (parsed for live + final render)
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../lib/paths.ts";
import { getPiInvocation } from "../lib/pi-invocation.ts";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import type { UsageStats } from "./render.ts";

export type RunStatus = "running" | "done" | "failed" | "aborted";

export interface RunMeta {
	agent: string;
	label: string;
	started: number;
}

export interface RunSummary {
	runId: string;
	status: RunStatus;
	agent: string;
	label: string;
	started: number;
	mtimeMs: number;
}

// Usage totals parsed from a run's stream; shaped for the shared renderer.
export type RunUsage = Required<UsageStats>;

// Hard caps so a hung agent can't run forever in the background.
const TIMEOUT_MS = 30 * 60 * 1000; // 30 min total
const STALL_MS = 5 * 60 * 1000; // 5 min with no output
// Finished runs older than this are reaped from disk on the next launch.
export const RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

// ── Storage primitives ───────────────────────────────────────────────────────

function runsBase(): string {
	return path.join(PATHS.stateRoot, "pi-bg-runs");
}

function runDir(id: string): string {
	return path.join(runsBase(), id);
}

function writeRunFile(id: string, name: string, content: string): void {
	try {
		fs.writeFileSync(path.join(runDir(id), name), content);
	} catch {
		/* best-effort */
	}
}

function appendRunFile(id: string, name: string, content: string): void {
	try {
		fs.appendFileSync(path.join(runDir(id), name), content);
	} catch {
		/* best-effort */
	}
}

function readRunFile(id: string, name: string): string | undefined {
	try {
		return fs.readFileSync(path.join(runDir(id), name), "utf-8");
	} catch {
		return undefined;
	}
}

function writeMeta(id: string, meta: RunMeta): void {
	writeRunFile(id, "meta.json", JSON.stringify(meta));
}

function readMeta(id: string): Partial<RunMeta> {
	const raw = readRunFile(id, "meta.json");
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Partial<RunMeta>;
	} catch {
		return {};
	}
}

export function readStatus(id: string): RunStatus | undefined {
	const s = readRunFile(id, "status")?.trim();
	return s ? (s as RunStatus) : undefined;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ── Live run tracking ────────────────────────────────────────────────────────

interface RunHandle {
	ac: AbortController;
	turns: number;
}

const liveRuns = new Map<string, RunHandle>();

/**
 * A run whose disk status says "running" but has no live handle in THIS process
 * (e.g. the extension host reloaded) is only really alive if its persisted pid
 * is still alive. Otherwise it was orphaned — flip it to "aborted" so it stops
 * showing as running.
 */
function reconcileStatus(id: string, status: RunStatus): RunStatus {
	if (status !== "running") return status;
	if (liveRuns.has(id)) return status;
	const pidStr = readRunFile(id, "pid");
	const pid = pidStr ? Number(pidStr.trim()) : NaN;
	if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return status;
	writeRunFile(id, "status", "aborted");
	writeRunFile(id, "finished", String(Date.now()));
	return "aborted";
}

// ── Spawn ─────────────────────────────────────────────────────────────────────────

async function spawnBgAgent(
	runId: string,
	agent: AgentConfig,
	task: string,
	cwd: string,
	handle: RunHandle,
): Promise<void> {
	const signal = handle.ac.signal;
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bgagent-"));
	const promptPath = path.join(tmpDir, "system.md");
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let lastOutput = "";

	try {
		if (agent.systemPrompt.trim()) {
			await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}
		args.push(`Task: ${task}`);
		const inv = getPiInvocation(args);

		await new Promise<void>((resolve) => {
			const proc = spawn(inv.command, inv.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (proc.pid !== undefined) writeRunFile(runId, "pid", String(proc.pid));

			let buffer = "";
			let lastActivity = Date.now();
			const startTime = Date.now();
			let done = false;

			const iv = setInterval(() => {
				const now = Date.now();
				if (now - startTime >= TIMEOUT_MS || now - lastActivity >= STALL_MS) {
					killProc();
					finish("aborted", 137);
				}
			}, 1000);

			function killProc() {
				if (proc.killed) return;
				proc.kill("SIGTERM");
				// Escalate to SIGKILL if the child ignores SIGTERM. Intentionally NOT
				// cleared by finish(): finish() resolves the wait immediately, but the
				// child may still be alive, so this timer must survive to force-kill it.
				// It's a no-op once the process has exited.
				const killTimer = setTimeout(() => {
					// proc.killed only means "a signal was sent", not "exited" — gate on
					// actual liveness so a SIGTERM-ignoring child is force-killed.
					if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				}, 5000);
				killTimer.unref?.();
			}

			function finish(status: RunStatus, code: number) {
				if (done) return;
				done = true;
				clearInterval(iv);
				writeRunFile(runId, "status", status);
				writeRunFile(runId, "result", lastOutput || "(no output)");
				writeRunFile(runId, "exit", String(code));
				writeRunFile(runId, "finished", String(Date.now()));
				try {
					fs.rmSync(path.join(runDir(runId), "pid"), { force: true });
				} catch {
					/* best-effort */
				}
				resolve();
			}

			const processLine = (line: string) => {
				if (!line.trim()) return;
				appendRunFile(runId, "stream.jsonl", line + "\n");
				lastActivity = Date.now();
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}
				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					handle.turns++;
					writeRunFile(runId, "turns", String(handle.turns));
					const text = (ev.message.content ?? [])
						.filter((c: any) => c?.type === "text")
						.map((c: any) => c.text)
						.join("\n");
					if (text) {
						lastOutput = text;
					}
				}
			};

			proc.stdout.on("data", (d: Buffer) => {
				buffer += d.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const l of lines) processLine(l);
			});
			proc.stderr.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				finish((code ?? 0) === 0 ? "done" : "failed", code ?? 0);
			});
			proc.on("error", () => finish("failed", 1));

			const onAbort = () => {
				killProc();
				finish("aborted", 1);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Launch a background agent run. Returns the generated runId immediately. */
export function launchRun(agentName: string, task: string, label: string, cwd: string): string {
	reapOldRuns(RETENTION_MS);
	const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	fs.mkdirSync(runDir(runId), { recursive: true });

	const agents = discoverAgents();
	const agent = agents.find((a) => a.name === agentName);
	const started = Date.now();
	writeMeta(runId, { agent: agentName, label, started });

	if (!agent) {
		const available = agents.map((a) => a.name).join(", ") || "none";
		writeRunFile(runId, "status", "failed");
		writeRunFile(runId, "result", `Unknown agent: "${agentName}". Available agents: ${available}.`);
		writeRunFile(runId, "exit", "1");
		writeRunFile(runId, "finished", String(started));
		return runId;
	}

	writeRunFile(runId, "status", "running");
	const handle: RunHandle = { ac: new AbortController(), turns: 0 };
	liveRuns.set(runId, handle);
	void spawnBgAgent(runId, agent, task, cwd, handle).finally(() => {
		liveRuns.delete(runId);
	});
	return runId;
}

export function getRunStatus(
	id: string,
): { status: RunStatus; elapsedMs: number; turns: number; label: string } | undefined {
	const disk = readStatus(id);
	if (!disk) return undefined;
	const status = reconcileStatus(id, disk);
	const meta = readMeta(id);
	const turns = Number(readRunFile(id, "turns") ?? "0") || 0;
	const started = meta.started ?? Date.now();
	// Finished runs freeze their elapsed at the recorded end time; running runs
	// tick from `started` to now.
	const end = status === "running" ? Date.now() : Number(readRunFile(id, "finished")) || Date.now();
	return { status, elapsedMs: end - started, turns, label: meta.label ?? id };
}

export function getRunResult(id: string): string | undefined {
	return readRunFile(id, "result");
}

/**
 * Read the full `stream.jsonl` for a run and parse it into the assistant/tool
 * `Message[]` shape the subagent renderer consumes, plus aggregated usage.
 * Best-effort: unparseable lines are skipped.
 */
export function readRunMessages(id: string): { messages: any[]; usage: RunUsage } {
	const raw = readRunFile(id, "stream.jsonl");
	const usage: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	if (!raw) return { messages: [], usage };
	const messages: any[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "message_end" && ev.message) {
			messages.push(ev.message);
			if (ev.message.role === "assistant") {
				usage.turns++;
				const u = ev.message.usage;
				if (u) {
					usage.input += u.input || 0;
					usage.output += u.output || 0;
					usage.cacheRead += u.cacheRead || 0;
					usage.cacheWrite += u.cacheWrite || 0;
					usage.cost += u.cost?.total || 0;
					usage.contextTokens = u.totalTokens || usage.contextTokens;
				}
			}
		} else if (ev.type === "tool_result_end" && ev.message) {
			messages.push(ev.message);
		}
	}
	return { messages, usage };
}

/**
 * Block until the run leaves "running", invoking `onUpdate` with the freshly
 * parsed messages+usage each poll so callers can render live. Returns the
 * terminal status, or "running" if the wait itself timed out (the run keeps
 * going in the background).
 */
export async function waitForRun(
	id: string,
	timeoutMs: number,
	onUpdate?: (snapshot: { messages: any[]; usage: RunUsage }) => void,
): Promise<RunStatus> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (onUpdate) onUpdate(readRunMessages(id));
		const status = reconcileStatus(id, readStatus(id) ?? "running");
		if (status !== "running") return status;
		if (Date.now() >= deadline) return "running";
		await new Promise((r) => setTimeout(r, 500));
	}
}

export function listRuns(): RunSummary[] {
	let ids: string[] = [];
	try {
		ids = fs
			.readdirSync(runsBase(), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
	const runs = ids.map((id): RunSummary => {
		const meta = readMeta(id);
		const status = reconcileStatus(id, readStatus(id) ?? "running");
		let mtimeMs = meta.started ?? 0;
		try {
			mtimeMs = fs.statSync(runDir(id)).mtimeMs;
		} catch {
			/* use started */
		}
		return {
			runId: id,
			status,
			agent: meta.agent ?? "?",
			label: meta.label ?? id,
			started: meta.started ?? 0,
			mtimeMs,
		};
	});
	return runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function killRun(id: string): boolean {
	const h = liveRuns.get(id);
	if (h) {
		h.ac.abort();
		return true;
	}
	// Not tracked in this process — kill by persisted pid, or reconcile stale state.
	const pidStr = readRunFile(id, "pid");
	const pid = pidStr ? Number(pidStr.trim()) : NaN;
	if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* race: already gone */
		}
		writeRunFile(id, "status", "aborted");
		writeRunFile(id, "finished", String(Date.now()));
		return true;
	}
	if (readStatus(id) === "running") {
		writeRunFile(id, "status", "aborted");
		writeRunFile(id, "finished", String(Date.now()));
		return true;
	}
	return false;
}

/**
 * Delete finished run directories older than `maxAgeMs`. Running runs are never
 * reaped. Best-effort; called on launch and session start to bound disk growth
 * and keep listRuns()/the widget from scanning unbounded history.
 */
export function reapOldRuns(maxAgeMs: number): void {
	const cutoff = Date.now() - maxAgeMs;
	let ids: string[] = [];
	try {
		ids = fs
			.readdirSync(runsBase(), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return;
	}
	for (const id of ids) {
		if (reconcileStatus(id, readStatus(id) ?? "running") === "running") continue;
		let mtimeMs = 0;
		try {
			mtimeMs = fs.statSync(runDir(id)).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs > cutoff) continue;
		try {
			fs.rmSync(runDir(id), { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
}
