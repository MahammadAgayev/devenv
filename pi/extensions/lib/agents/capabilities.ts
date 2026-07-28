/**
 * capabilities.ts — discover the capability registry (pi/registry/*.md).
 *
 * Shared by registry.ts (prompt/agent tools) and job-manager.ts (background
 * jobs) so both read the same single source of truth.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { PATHS } from "../paths.ts";

export interface Capability {
  name: string;
  prompt?: string;
  agent?: string;
  tools?: string[];
  model?: string;
  body: string;
}

export interface AgentBrief {
  goal: string;
  task: string;
  context?: string;
  critical_files?: string[];
  open_questions?: string[];
}

/** Assemble a structured brief into the markdown task a sub-agent receives. */
export function formatBrief(b: AgentBrief): string {
  const parts = [`# Goal\n${b.goal.trim()}`, `# Task\n${b.task.trim()}`];
  if (b.context?.trim()) parts.push(`# Context\n${b.context.trim()}`);
  if (b.critical_files?.length) parts.push(`# Critical files\n${b.critical_files.map((f) => `- ${f}`).join("\n")}`);
  if (b.open_questions?.length) parts.push(`# Open questions\n${b.open_questions.map((q) => `- ${q}`).join("\n")}`);
  return parts.join("\n\n");
}

/**
 * Locate the `registry/` folder of capability files. Resolved by the central
 * path module (module-relative, so it works both symlinked and as an installed
 * pi package); override with `PI_REGISTRY_DIR` for isolated testing.
 */
export function registryDir(): string {
  return PATHS.registryDir;
}

export function discover(): Capability[] {
  const dir = registryDir();
  if (!fs.existsSync(dir)) return [];
  const caps: Capability[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, entry.name), "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(raw);
    if (!frontmatter.name) continue;
    const tools = frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean);
    caps.push({
      name: frontmatter.name,
      prompt: frontmatter.prompt,
      agent: frontmatter.agent,
      tools: tools?.length ? tools : undefined,
      model: frontmatter.model,
      body: body.trim(),
    });
  }
  return caps;
}

/** Find a capability that exposes an agent flavor, by capability name or agent name. */
export function findAgentCapability(query: string): Capability | undefined {
  const q = query.trim().toLowerCase();
  return discover().find((c) => c.agent && (c.name.toLowerCase() === q || c.agent.toLowerCase() === q));
}
