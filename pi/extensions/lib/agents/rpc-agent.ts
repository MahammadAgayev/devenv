/**
 * rpc-agent.ts — a persistent sub-agent backed by `pi --mode rpc`.
 *
 * Unlike the one-shot `pi --mode json -p` spawn, an RPC child stays alive: we
 * can send follow-up prompts, steer it mid-run, abort it, and read its state.
 * That is what makes background jobs queueable, watchable, and steerable.
 *
 * Framing: RPC mode is strict JSONL with LF as the ONLY delimiter. The docs
 * warn that Node's `readline` is non-compliant (it also splits on U+2028/U+2029
 * which are valid inside JSON strings), so we split on "\n" by hand.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

export type RpcEvent = { type: string; [k: string]: any };

/** Dialog methods block the child on stdin; we auto-cancel them (no human at
 * the child's UI). Fire-and-forget methods (notify/setStatus/…) are ignored. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface RpcAgentOptions {
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  cwd: string;
  onEvent: (event: RpcEvent) => void;
  onExit: (code: number | null) => void;
}

/** A live RPC child process. Methods write one JSON command per line to stdin. */
export class RpcAgent {
  private proc: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private exited = false;
  private disposed = false;
  stderr = "";

  constructor(opts: RpcAgentOptions) {
    const args = ["--mode", "rpc", "--no-session"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
    if (opts.systemPrompt?.trim()) args.push("--append-system-prompt", opts.systemPrompt);

    const inv = getPiInvocation(args);
    this.proc = spawn(inv.command, inv.args, { cwd: opts.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      // LF-only framing (see file header).
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!trimmed.trim()) continue;
        let event: RpcEvent;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        // A child's own extensions may pop dialogs and block on stdin waiting
        // for a reply; auto-cancel so the job never hangs. No human is at the
        // child's UI.
        if (event.type === "extension_ui_request" && DIALOG_METHODS.has(event.method)) {
          this.raw({ type: "extension_ui_response", id: event.id, cancelled: true });
          continue;
        }
        // Ignore command responses and fire-and-forget UI requests; callers
        // only care about the agent event stream.
        if (event.type !== "response" && event.type !== "extension_ui_request") opts.onEvent(event);
      }
    });
    this.proc.stderr?.on("data", (d: Buffer) => {
      this.stderr += d.toString();
    });
    this.proc.on("close", (code) => {
      this.exited = true;
      opts.onExit(code);
    });
    this.proc.on("error", () => {
      this.exited = true;
      opts.onExit(1);
    });
  }

  private raw(cmd: Record<string, unknown>): void {
    if (!this.proc.stdin?.writable) return;
    this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  private send(cmd: Record<string, unknown>): void {
    this.raw({ id: `req-${this.nextId++}`, ...cmd });
  }

  /** Send the initial (or a fresh) prompt. Triggers a new turn when idle. */
  prompt(message: string): void {
    this.send({ type: "prompt", message });
  }

  /** Queue a message while streaming — delivered before the next LLM call. */
  steer(message: string): void {
    this.send({ type: "steer", message });
  }

  /** Queue a message to run after the agent finishes its current work. */
  followUp(message: string): void {
    this.send({ type: "follow_up", message });
  }

  /** Prompt if idle, else steer. Convenience for the interactive "ask/steer" path.
   * Both verbs are needed: a bare `prompt` on a busy child is rejected
   * ("already processing"), while `steer` on an idle child is accepted but never
   * runs (it only queues before the *next* LLM call, and idle has none). */
  ask(message: string, streaming: boolean): void {
    if (streaming) this.steer(message);
    else this.prompt(message);
  }

  abort(): void {
    this.send({ type: "abort" });
  }

  /** Abort the current run and terminate the child process. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort();
    this.proc.stdin?.end();
    this.proc.kill("SIGTERM");
    // proc.killed only means "a signal was sent", not "exited" — track real exit.
    const t = setTimeout(() => {
      if (!this.exited) this.proc.kill("SIGKILL");
    }, 3000);
    this.proc.on("close", () => clearTimeout(t));
  }
}
