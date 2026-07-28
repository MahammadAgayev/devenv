/**
 * job-manager.ts — background agent jobs backed by persistent RPC children.
 *
 * A "job" is a running (or finished) sub-agent you fired with /ask. It does NOT
 * block the main turn — pi stays interactive while jobs run. Jobs are watchable
 * (live widget + /agents viewer), steerable (send a follow-up to a running job),
 * and their results are delivered back without interrupting you.
 *
 * Session-scoped: created on demand, disposed on session_shutdown.
 */

import { RpcAgent, type RpcEvent } from "./rpc-agent.ts";

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobMessageItem {
  type: "text" | "tool";
  text: string;
}

export interface Job {
  id: string;
  /** Capability name (e.g. "review"). */
  cap: string;
  /** Agent label (e.g. "reviewer"). */
  label: string;
  title: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  /** True while the child is mid-turn (streaming). */
  streaming: boolean;
  /** Latest tool the agent invoked, for the "→ tool" tail. */
  lastTool?: string;
  /** Chronological transcript items (assistant text + tool calls). */
  items: JobMessageItem[];
  /** Final assistant text once done. */
  finalText: string;
  agent: RpcAgent;
}

export interface JobSpec {
  cap: string;
  label: string;
  title: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  /** The full brief sent as the first prompt. */
  prompt: string;
}

/** Concatenate all text blocks from a finalized message event. */
function messageText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n\n");
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private seq = 0;
  private cwd: string;
  /** Called whenever any job's state changes, so the UI can refresh. */
  onChange: (job: Job) => void;
  /** Called once each time a job finishes a turn (agent_end), for result delivery. */
  onComplete: (job: Job) => void;

  constructor(cwd: string, onChange: (job: Job) => void, onComplete: (job: Job) => void) {
    this.cwd = cwd;
    this.onChange = onChange;
    this.onComplete = onComplete;
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  activeCount(): number {
    return this.list().filter((j) => j.status === "running").length;
  }

  start(spec: JobSpec): Job {
    const id = `j${++this.seq}`;
    const agent = new RpcAgent({
      systemPrompt: spec.systemPrompt,
      model: spec.model,
      tools: spec.tools,
      cwd: this.cwd,
      onEvent: (e) => this.handleEvent(id, e),
      onExit: (code) => this.handleExit(id, code),
    });
    const job: Job = {
      id,
      cap: spec.cap,
      label: spec.label,
      title: spec.title,
      status: "running",
      startedAt: Date.now(),
      streaming: false,
      items: [],
      finalText: "",
      agent,
    };
    this.jobs.set(id, job);
    agent.prompt(spec.prompt);
    // The child is busy from the instant we prompt it; agent_start only confirms
    // this later. Set streaming now so an immediate ask() steers instead of
    // sending a second bare prompt (which the child rejects as "already processing").
    job.streaming = true;
    this.onChange(job);
    return job;
  }

  /** Send a message to a running or idle job: steer if mid-turn, else prompt. */
  ask(id: string, message: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.status !== "running" && job.status !== "done")) return false;
    job.agent.ask(message, job.streaming);
    if (job.status === "done") {
      job.status = "running";
      job.endedAt = undefined;
      // Re-prompted an idle child; it is busy again until the next agent_end.
      job.streaming = true;
      this.onChange(job);
    }
    return true;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.status !== "running" && job.status !== "done")) return false;
    job.agent.dispose();
    job.status = "cancelled";
    job.endedAt = Date.now();
    this.onChange(job);
    return true;
  }

  cancelAll(): number {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.status === "done") {
        job.agent.dispose();
        job.status = "cancelled";
        job.endedAt = Date.now();
        n++;
        this.onChange(job);
      }
    }
    return n;
  }

  /** Drop all finished jobs (cancelled/failed/done) from the list, disposing
   * their children. Running jobs are left untouched. Returns how many cleared. */
  tidy(): number {
    const done = [...this.jobs.values()].filter((j) => j.status !== "running");
    for (const job of done) {
      job.agent.dispose();
      this.jobs.delete(job.id);
    }
    if (done.length) this.onChange(done[0]);
    return done.length;
  }

  disposeAll(): void {
    for (const job of this.jobs.values()) job.agent.dispose();
    this.jobs.clear();
  }

  private handleEvent(id: string, e: RpcEvent): void {
    const job = this.jobs.get(id);
    if (!job) return;
    switch (e.type) {
      case "agent_start":
        job.streaming = true;
        break;
      case "tool_execution_start":
        job.lastTool = e.toolName;
        job.items.push({ type: "tool", text: e.toolName ?? "tool" });
        break;
      case "message_end": {
        const text = messageText(e.message);
        if (e.message?.role === "assistant" && text) {
          job.items.push({ type: "text", text });
          job.finalText = text;
        }
        break;
      }
      case "agent_end":
        // Turn finished; the RPC child persists (idle, ready for a follow-up),
        // but we mark the job done and deliver its result now.
        job.streaming = false;
        job.lastTool = undefined;
        if (job.status === "running") {
          job.status = "done";
          job.endedAt = Date.now();
          this.onChange(job);
          this.onComplete(job);
        }
        return;
      default:
        // Non-display-affecting event (queue_update, message_start, deltas, …).
        return;
    }
    this.onChange(job);
  }

  private handleExit(id: string, code: number | null): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.status === "running") {
      job.status = code && code !== 0 ? "failed" : "done";
      job.endedAt = Date.now();
      if (!job.finalText && this.jobStderr(job)) job.finalText = this.jobStderr(job);
    }
    job.streaming = false;
    this.onChange(job);
  }

  private jobStderr(job: Job): string {
    return job.agent.stderr.trim();
  }
}
