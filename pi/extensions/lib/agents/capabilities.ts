/**
 * capabilities.ts — discover the capability registry (pi/registry/*.md).
 *
 * Used by registry.ts to expose each file's `prompt:` flavor as an in-context
 * /<cmd>. The subagent tool reads the same files via subagent/agents.ts.
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
