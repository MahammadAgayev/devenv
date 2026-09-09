/**
 * Run state: `~/.pi/harness/<name>/`.
 *
 * Runs live under the user config dir, beside `~/.pi/tasks/`, not inside the
 * project. Three reasons: a run outlives any one checkout, two projects can
 * have runs going at once without colliding, and — the practical one — the
 * commit backstop in `loop.ts` would otherwise keep committing the harness's
 * own logs into the repo it is working on.
 *
 * The folder is the run:
 *
 *   ~/.pi/harness/<name>/
 *     task.md      the contract — goal, done-when, constraints. Written at
 *                  init, edited by hand, read by the agent every iteration.
 *     state.json   iteration count, session chain, last verdict. This module.
 *     log.md       lab notes, appended by the agent as it goes.
 *     AGENT_STOP   presence halts the run
 *     STEER.md     injected once, then cleared
 *     …            whatever else the agent leaves behind
 *
 * Everything the loop needs to resume is in `state.json` and nowhere else —
 * not in closure scope. That is forced by session replacement (captured
 * objects go stale after `newSession()`), and it also makes a run survivable
 * across a crash, a `/reload`, or a restart of pi itself.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi's config dir name.
 *
 * Inlined rather than imported from `@earendil-works/pi-coding-agent` so this
 * module has no package imports at all: it is then loadable — and testable —
 * without a node_modules, which the repo deliberately does not have. The value
 * is part of pi's public API surface and has never changed.
 */
const CONFIG_DIR_NAME = ".pi";

/**
 * What the oracle said about an iteration.
 *
 *   PASS    the reviewer judged the work finished
 *   FAIL    the reviewer returned NEEDS_WORK — a real reading, keep going
 *   ERROR   the reviewer could not be run at all, so nothing was measured
 *   UNKNOWN no iteration has been judged yet
 *
 * FAIL and ERROR are kept apart because they call for opposite responses:
 * iterating on FAIL is the point, iterating on ERROR burns tokens producing no
 * signal.
 */
export type Verdict = "PASS" | "FAIL" | "ERROR" | "UNKNOWN";

export type RunStatus = "idle" | "running" | "done" | "stopped" | "failed";

export interface IterationRecord {
  iteration: number;
  verdict: Verdict;
  timestamp: string;
}

export interface HarnessState {
  /** Run name; also the folder name under ~/.pi/harness. */
  name: string;

  /** Where the work happens. The run folder is not the working directory. */
  cwd: string;

  status: RunStatus;
  iteration: number;

  /** Session files this run has occupied, oldest first. Grows on each reset. */
  sessionChain: string[];

  lastVerdict: Verdict;
  /** The reviewer's findings from the last iteration, clipped. */
  lastOutput: string;
  history: IterationRecord[];

  createdAt: string;
  updatedAt: string;
}

export function harnessRoot(): string {
  return join(homedir(), CONFIG_DIR_NAME, "harness");
}

export function runDir(name: string): string {
  return join(harnessRoot(), name);
}

export function taskPath(name: string): string {
  return join(runDir(name), "task.md");
}

export function statePath(name: string): string {
  return join(runDir(name), "state.json");
}

export function logPath(name: string): string {
  return join(runDir(name), "log.md");
}

export function stopPath(name: string): string {
  return join(runDir(name), "AGENT_STOP");
}

export function steerPath(name: string): string {
  return join(runDir(name), "STEER.md");
}

/**
 * Longest run name we will create.
 *
 * A name is a directory under `~/.pi/harness/` and is echoed into every
 * iteration prompt, twice, along with the paths built from it. Sentence-length
 * names ("Refactor harness, make architecturally correct" → a 45-character
 * folder) are what happens when the prompt is answered with a description
 * instead of a label, so trim rather than let it through.
 */
const MAX_NAME_LENGTH = 40;

/**
 * Keep run names filesystem-safe, bounded, and predictable for autocompletion.
 *
 * Truncation cuts at a word boundary when there is one in range, so a clipped
 * name still reads as words rather than ending mid-token.
 */
export function sanitize(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");

  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;

  const clipped = cleaned.slice(0, MAX_NAME_LENGTH);
  const lastDash = clipped.lastIndexOf("-");
  // Only prefer the word boundary if it keeps most of the budget; otherwise a
  // name like "aaaa...-b" would collapse to almost nothing.
  const cut = lastDash >= MAX_NAME_LENGTH / 2 ? clipped.slice(0, lastDash) : clipped;
  return cut.replace(/[-.]+$/, "");
}

export function listRuns(): string[] {
  const root = harnessRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(statePath(name)))
    .sort();
}

export function runExists(name: string): boolean {
  return existsSync(statePath(name));
}

/**
 * Read a run's state, or null if it cannot be had.
 *
 * Null-returning rather than throwing because every caller has a sensible
 * "then there is no run" path, and none of them can do anything useful with an
 * exception in the middle of a loop iteration.
 *
 * It does mean the two failures — no such run, and a run whose state.json is
 * damaged — arrive here as the same value. Callers that report to the user
 * should say which, via `describeReadFailure`.
 */
export function readState(name: string): HarnessState | null {
  try {
    return JSON.parse(readFileSync(statePath(name), "utf-8")) as HarnessState;
  } catch {
    return null;
  }
}

/**
 * A user-facing sentence explaining why `readState(name)` came back empty.
 *
 * The distinction is worth the extra stat: "no run named X" is a typo, while "X
 * is unreadable" is a run that still exists, whose folder is worth opening.
 * Reported as one message, the second case sent people hunting for a run that
 * was sitting right there with a truncated state.json.
 *
 * Derived from the filesystem rather than remembered from the failed read, so
 * it has no ordering requirement and no state to go stale.
 */
export function describeReadFailure(name: string): string {
  if (!existsSync(statePath(name))) return `harness: no run named "${name}"`;
  return `harness: run "${name}" has an unreadable state.json — see ${runDir(name)}`;
}

/**
 * Persist state.
 *
 * Written via a temp file and renamed, because the loop writes this after every
 * iteration and a crash mid-write would otherwise leave a truncated JSON file —
 * which is exactly the moment the state is most needed.
 */
export function writeState(state: HarnessState): void {
  const dir = runDir(state.name);
  mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const target = statePath(state.name);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, target);
}

export function createRun(opts: {
  name: string;
  cwd: string;
  task: string;
}): HarnessState {
  const now = new Date().toISOString();
  mkdirSync(runDir(opts.name), { recursive: true });

  writeFileSync(taskPath(opts.name), opts.task, { encoding: "utf-8", mode: 0o600 });

  if (!existsSync(logPath(opts.name))) {
    writeFileSync(
      logPath(opts.name),
      [
        `# Log: ${opts.name}`,
        "",
        "Lab notes for this run. The agent appends here every iteration:",
        "what it tried, what happened, what it learned, what it ruled out.",
        "",
      ].join("\n"),
      { encoding: "utf-8", mode: 0o600 },
    );
  }

  const state: HarnessState = {
    name: opts.name,
    cwd: opts.cwd,
    status: "idle",
    iteration: 0,
    sessionChain: [],
    lastVerdict: "UNKNOWN",
    lastOutput: "",
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  writeState(state);
  return state;
}

export function readTask(name: string): string {
  try {
    return readFileSync(taskPath(name), "utf-8");
  } catch {
    return "";
  }
}

/** Append a bullet to the run's log. Best-effort: never breaks the loop. */
export function appendLog(name: string, line: string): void {
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    writeFileSync(logPath(name), `\n- ${stamp} — ${line}\n`, { encoding: "utf-8", flag: "a" });
  } catch {
    // A log write failing is not a reason to abandon a run.
  }
}

export function stopRequested(name: string): boolean {
  return existsSync(stopPath(name));
}

export function requestStop(name: string): void {
  writeFileSync(stopPath(name), `stop requested ${new Date().toISOString()}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function clearStop(name: string): void {
  try {
    rmSync(stopPath(name));
  } catch {
    // Already absent — that is the desired state either way.
  }
}

/**
 * Read and consume `STEER.md`.
 *
 * Consumed on read so a redirection lands exactly once. Left in place it would
 * be re-injected every iteration, and the agent would keep obeying a course
 * correction long after it had made it.
 */
export function takeSteer(name: string): string | null {
  const path = steerPath(name);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
  try {
    rmSync(path);
  } catch {
    // If it cannot be removed, better to drop it than to repeat it forever.
    try {
      writeFileSync(path, "", "utf-8");
    } catch {
      /* give up quietly */
    }
  }
  return text || null;
}

/** Newest-first by mtime, for picking a default run when none is named. */
export function runsByRecency(): string[] {
  return listRuns()
    .map((name) => {
      let mtime = 0;
      try {
        mtime = statSync(statePath(name)).mtimeMs;
      } catch {
        /* unreadable: sorts last */
      }
      return { name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((r) => r.name);
}
