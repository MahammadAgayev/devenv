/**
 * Prompt templates.
 *
 * Separated from `loop.ts` because these are the part that gets tuned. The loop
 * mechanics are close to fixed; the wording of what the agent is told each
 * iteration is what decides whether a run converges or thrashes.
 *
 * Three prompts:
 *   - `iterationPrompt`   sent every iteration
 *   - `resetSeed`         the one message a post-reset session wakes up holding
 *   - `finalNotePrompt`   asks for a closing log entry when the run ends
 */

import type { HarnessState } from "./state.ts";

export interface PromptInput {
  state: HarnessState;
  task: string;
  runDir: string;
  /** Evaluator findings from the previous iteration, when it returned NEEDS_WORK. */
  evaluatorFindings?: string;
  /** Contents of STEER.md, consumed this iteration. */
  steer?: string;
  /** True on the first iteration of a fresh session (start or post-reset). */
  freshSession: boolean;
}

/**
 * The per-iteration instruction.
 *
 * Deliberately re-states the task and the file paths every single time. In a
 * long run the agent's context is regularly wiped, and even when it is not, the
 * task scrolls out of the useful window. Repetition is cheap; a drifted agent
 * that has forgotten its criterion is not.
 */
export function iterationPrompt(input: PromptInput): string {
  const { state, task, runDir } = input;
  const parts: string[] = [];

  parts.push(`[HARNESS · iteration ${state.iteration + 1} of run "${state.name}"]`);
  parts.push("");

  if (input.steer) {
    // First, and unmistakable: a steer is the user interrupting, and it
    // outranks whatever the agent had planned.
    parts.push("## ⚠ Course correction from the user");
    parts.push("");
    parts.push("This arrived since your last iteration. It takes priority:");
    parts.push("");
    parts.push(input.steer);
    parts.push("");
  }

  parts.push("## Task");
  parts.push("");
  parts.push(task.trim() || "(task.md is empty — read it and ask for clarification in your log)");
  parts.push("");

  parts.push("## Where things stand");
  parts.push("");
  parts.push(`- Working directory: \`${state.cwd}\``);
  parts.push(`- Run folder: \`${runDir}\` — your notes and artifacts live here`);
  parts.push(`- Validation command: \`${state.validationCommand}\``);
  parts.push(`- Iterations so far: ${state.iteration}`);
  parts.push(`- Last verdict: ${state.lastVerdict}`);

  if (state.sessionChain.length > 1) {
    parts.push(`- Context resets so far: ${state.sessionChain.length - 1}`);
  }
  parts.push("");

  if (input.freshSession) {
    // A fresh session knows nothing. Point it at the log before it does
    // anything else, or it will happily redo work it already finished.
    parts.push("**This is a fresh context — you have no memory of earlier iterations.**");
    parts.push(`Read \`${runDir}/log.md\` first. It is your own notes from previous iterations:`);
    parts.push("what is done, what failed, what you already ruled out. Trust it, but verify");
    parts.push("anything load-bearing against the actual files before building on it.");
    parts.push("");
  }

  if (state.lastVerdict === "FAIL" && state.lastOutput) {
    parts.push("## Last validation output");
    parts.push("");
    parts.push("```");
    parts.push(state.lastOutput);
    parts.push("```");
    parts.push("");
  }

  if (state.lastVerdict === "ERROR" && state.lastOutput) {
    parts.push("## The validation command itself failed to run");
    parts.push("");
    parts.push("```");
    parts.push(state.lastOutput);
    parts.push("```");
    parts.push("");
    parts.push("This is not a test failure — the oracle is broken. Fix whatever stops the");
    parts.push("command from running (missing dependency, wrong path, syntax error) before");
    parts.push("doing anything else. Until it runs, no progress can be measured.");
    parts.push("");
  }

  if (input.evaluatorFindings) {
    parts.push("## Reviewer findings");
    parts.push("");
    parts.push("The validation command passed, but an independent reviewer that did not watch");
    parts.push("you write this found the work incomplete:");
    parts.push("");
    parts.push(input.evaluatorFindings);
    parts.push("");
    parts.push("Address this. Do not argue with it by making the check weaker.");
    parts.push("");
  }

  parts.push("## What to do now");
  parts.push("");
  parts.push("Advance the task by one meaningful increment. Concretely:");
  parts.push("");
  parts.push(`1. Run \`${state.validationCommand}\` to see the current state for yourself.`);
  parts.push("2. Pick the single most valuable thing you can finish this iteration.");
  parts.push("3. Do it, and verify it with the validation command.");
  parts.push(`4. Append what happened to \`${runDir}/log.md\` — what you tried, what the`);
  parts.push("   result was, and anything a future you with no memory would need. Dead ends");
  parts.push("   are worth more than successes here: they stop the next iteration repeating them.");
  parts.push("");
  parts.push("Work only within the task. Do not refactor code the task did not ask about.");
  parts.push("Stop when the increment is done — the harness will run the validation command");
  parts.push("itself and start your next iteration. You do not need to loop.");

  return parts.join("\n");
}

/**
 * The seed message for a session created by a context reset.
 *
 * This is the entire inheritance from the previous session — everything else is
 * gone by design. It says where to look rather than trying to summarise the
 * work, because `log.md` is already the summary and duplicating it here would
 * just be a second thing to keep in sync.
 */
export function resetSeed(state: HarnessState, runDir: string): string {
  return [
    // sessionChain holds the sessions used SO FAR; the replacement is appended
    // only once runLoop re-enters. So the reset about to happen is length, not
    // length - 1, and the first one must read "reset 1" rather than "reset 0".
    `[HARNESS · context reset ${Math.max(1, state.sessionChain.length)} for run "${state.name}"]`,
    "",
    "The previous session filled its context window and was replaced. You are its",
    "continuation, with none of its memory.",
    "",
    "Everything that survived is on disk:",
    "",
    `- \`${runDir}/task.md\` — the task. This is the contract; it has not changed.`,
    `- \`${runDir}/log.md\` — your own notes from ${state.iteration} previous iterations.`,
    `- \`${state.cwd}\` — the working tree, with the work so far in it.`,
    "",
    `Progress so far: ${state.iteration} iterations, last verdict ${state.lastVerdict}.`,
    "",
    "Do not start over. Read the log, confirm the current state with",
    `\`${state.validationCommand}\`, and continue from there.`,
  ].join("\n");
}

/**
 * Closing instruction when a run ends.
 *
 * Worth the extra turn: the final state is exactly what someone reads first
 * when they come back to a finished or abandoned run.
 */
export function finalNotePrompt(state: HarnessState, runDir: string, reason: string): string {
  return [
    `[HARNESS · run "${state.name}" is ending: ${reason}]`,
    "",
    `Write a closing entry in \`${runDir}/log.md\`:`,
    "",
    "- What state the work is actually in right now",
    "- What is finished and verified, versus finished and unverified",
    "- What remains, in enough detail to be picked up cold",
    "- Anything that would mislead someone reading only the code",
    "",
    "Then stop. Do not start new work.",
  ].join("\n");
}
