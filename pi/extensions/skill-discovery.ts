/**
 * skill-discovery
 *
 * @desc: Skill discovery for pi — scans the playground package, the AIFX dev-workflow marketplace, and the session's working directory for SKILL.md files. Lazy mode (default) exposes a find_skill tool for on-demand discovery; full mode eager-loads marketplace skills into the prompt. Command: /skill-discovery.
 *
 * Three sources of skills are bridged into pi:
 *   1. Playground package — agents/plugins/<plugin>/skills/<skill>/SKILL.md (always)
 *   2. AIFX/Claude agent-marketplace core/dev-workflow — marketplace skills
 *      (lazy by default, full mode via PI_SKILLS_MODE=full)
 *   3. Working directory — <cwd>/agents/plugins/<plugin>/skills/<skill>/SKILL.md, so
 *      repo-specific skills are discoverable alongside playground + marketplace
 *
 * Claude Code gets marketplace skills via the agent-marketplace plugin system.
 * Pi has no built-in Claude plugin loader, but it can accept additional skill
 * directories from extensions during resources_discover, and the find_skill
 * tool lets the model discover them on demand without bloating the prompt.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATHS } from "../lib/paths.ts";
import { Type } from "typebox";

// Skill loading mode for marketplace skills:
//   "lazy" (default) — do NOT inject the ~130 marketplace skill descriptions
//     into <available_skills>; expose a `find_skill` tool so the model (and the
//     router) can discover + load them on demand. Saves ~8-9k prompt tokens.
//   "full" — eager-load every marketplace skill into the prompt (legacy).
// PI_SKILLS_MODE is the canonical env var; PI_AIFX_SKILLS_MODE is kept as a
// fallback for backward compatibility.
const SKILLS_MODE = (process.env.PI_SKILLS_MODE ?? process.env.PI_AIFX_SKILLS_MODE ?? "lazy").toLowerCase();

interface ClaudeMarketplaceConfig {
  [name: string]: {
    installLocation?: string;
    source?: {
      path?: string;
    };
  };
}

const DEV_WORKFLOW_RELATIVE_PARTS = [
  "claude-code",
  "plugins",
  "core",
  "dev-workflow",
];

function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readAgentMarketplaceRoots(): string[] {
  const roots: string[] = [];
  const knownMarketplacesPath = PATHS.knownMarketplacesJson;

  try {
    const raw = readFileSync(knownMarketplacesPath, "utf-8");
    const config = parseJsonSafe<ClaudeMarketplaceConfig>(raw);
    const marketplace = config?.["agent-marketplace"];
    if (marketplace?.installLocation) roots.push(marketplace.installLocation);
    if (marketplace?.source?.path) roots.push(marketplace.source.path);
  } catch {
    // Claude may not have initialized plugin marketplace metadata yet.
  }

  // AIFX's stable local marketplace checkout used by Claude's agent-marketplace.
  roots.push(PATHS.aifxDevWorkflowMarketplace);

  return [...new Set(roots)];
}

function resolveCoreDevWorkflowPath(): string | null {
  for (const root of readAgentMarketplaceRoots()) {
    const candidate = join(root, ...DEV_WORKFLOW_RELATIVE_PARTS);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function skillNameFromMarkdown(content: string): string | null {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;

  const nameLine = frontmatter[1].match(/^name:\s*(.+?)\s*$/m);
  if (!nameLine) return null;

  return nameLine[1].trim().replace(/^['"]|['"]$/g, "");
}

function readSkillName(skillDir: string): string | null {
  try {
    return skillNameFromMarkdown(readFileSync(join(skillDir, "SKILL.md"), "utf-8"));
  } catch {
    return null;
  }
}

function playgroundRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

// Run the canonical ranker (agents/lib/find-skill.js) and return its candidates,
// with each candidate's relative `path` resolved to an absolute SKILL.md path.
// Includes the session's working directory (sessionCwd) so repo-specific skills
// are discoverable alongside playground + marketplace skills.
interface SkillCandidate {
  name: string;
  plugin: string;
  description: string;
  score: number;
  reason: string;
  skillFile: string;
}

function runFindSkill(repoRoot: string, query: string, max: number, sessionCwd?: string): SkillCandidate[] {
  const script = join(repoRoot, "agents", "lib", "find-skill.js");
  try {
    const args = [script, query, "--market", "--max", String(max)];
    if (sessionCwd) args.push("--cwd", sessionCwd);
    const out = execFileSync("node", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 15000,
    });
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c: any) => ({
      name: String(c.name ?? ""),
      plugin: String(c.plugin ?? ""),
      description: String(c.description ?? ""),
      score: Number(c.score ?? 0),
      reason: String(c.reason ?? ""),
      // Resolve relative path against the candidate's own root.  Playground
      // and marketplace skills are relative to repoRoot; cwd skills carry an
      // absolute cwdRoot so they resolve correctly even outside playground.
      skillFile: c.cwdRoot
        ? join(String(c.cwdRoot), String(c.path ?? "."), "SKILL.md")
        : join(resolve(repoRoot, String(c.path ?? ".")), "SKILL.md"),
    }));
  } catch {
    return [];
  }
}

function readPlaygroundSkillNames(): Set<string> {
  const root = playgroundRoot();
  const names = new Set<string>();

  try {
    const raw = readFileSync(join(root, "package.json"), "utf-8");
    const pkg = parseJsonSafe<{ pi?: { skills?: string[] } }>(raw);
    for (const skillPath of pkg?.pi?.skills ?? []) {
      // package.json only uses concrete relative paths here. Ignore any future
      // glob-style entries rather than guessing what pi's package resolver will do.
      if (skillPath.includes("*")) continue;

      const absPath = resolve(root, skillPath);
      const skillDir = existsSync(join(absPath, "SKILL.md")) ? absPath : dirname(absPath);
      const name = readSkillName(skillDir);
      if (name) names.add(name);
    }
  } catch {
    // If the package manifest is unavailable, prefer loading marketplace skills.
  }

  return names;
}

interface ResolvedSkillDirs {
  root: string;
  skillPaths: string[];
  skippedCollisions: Array<{ name: string; path: string }>;
}

function scanSkillDirs(root: string): Array<{ name: string; path: string }> {
  const found: Array<{ name: string; path: string }> = [];

  function walk(dir: string): void {
    if (existsSync(join(dir, "SKILL.md"))) {
      const name = readSkillName(dir);
      if (name) found.push({ name, path: dir });
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = join(dir, entry.name);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(child);
    }
  }

  walk(root);
  return found;
}

function resolveCoreDevWorkflowSkillDirs(): ResolvedSkillDirs | null {
  const root = resolveCoreDevWorkflowPath();
  if (!root) return null;

  const playgroundSkillNames = readPlaygroundSkillNames();
  const seen = new Set<string>();
  const skillPaths: string[] = [];
  const skippedCollisions: Array<{ name: string; path: string }> = [];

  for (const skill of scanSkillDirs(root)) {
    if (playgroundSkillNames.has(skill.name) || seen.has(skill.name)) {
      skippedCollisions.push(skill);
      continue;
    }

    seen.add(skill.name);
    skillPaths.push(skill.path);
  }

  return { root, skillPaths, skippedCollisions };
}

// ── Workspace skill cache ───────────────────────────────────────────────
//
// Teams in go-code (and other monorepos) check skills into .claude/skills/ and
// .cursor/skills/ within their service directories — 645+ as of 2026-07.
// Scanning these on every find_skill call would block for ~5s via `find`, so we
// pre-scan in the background on session_start and write a cache file that
// find-skill.js reads instantly.
//
// Cache layout: ~/.cache/pi/workspace-skills-<hash>.json where <hash> is a
// short hash of the cwd, so multiple workspaces coexist.

interface WorkspaceSkillEntry {
  name: string;
  description: string;
  plugin: string;
  path: string; // absolute SKILL.md path
}

interface WorkspaceSkillCache {
  cwd: string;
  scannedAt: string; // ISO timestamp
  skills: WorkspaceSkillEntry[];
}

function workspaceSkillCachePath(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(PATHS.cacheRoot, "pi", `workspace-skills-${hash}.json`);
}

function readWorkspaceSkillCache(cwd: string): WorkspaceSkillCache | null {
  try {
    const raw = readFileSync(workspaceSkillCachePath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as WorkspaceSkillCache;
    if (parsed.cwd !== cwd) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Parse frontmatter name + description from a SKILL.md file path.
function parseSkillFrontmatter(mdPath: string): { name: string; description: string } | null {
  try {
    const raw = readFileSync(mdPath, "utf-8");
    const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const name = (fm[1].match(/^name:\s*(.+?)\s*$/m)?.[1] ?? "").replace(/^["']|["']$/g, "").trim();
    const description = (fm[1].match(/^description:\s*(.+?)\s*$/m)?.[1] ?? "").replace(/^["']|["']$/g, "").trim();
    if (!name) return null;
    return { name, description };
  } catch {
    return null;
  }
}

// Background scan: runs `find` async, parses frontmatter, writes cache.
// Fire-and-forget — never blocks session start. If it fails, find-skill.js
// will simply not find workspace skills until the next session (graceful
// degradation).
function refreshWorkspaceSkillCache(cwd: string): void {
  const cacheDir = join(PATHS.cacheRoot, "pi");
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    return;
  }

  // Skip scanning if cwd is the playground root — those skills are already
  // covered by the playground scan in find-skill.js.
  if (resolve(cwd) === resolve(playgroundRoot())) return;

  execFile(
    "find",
    [cwd, "-maxdepth", "10", "\(", "-path", "*/.claude/skills/*/SKILL.md", "-o", "-path", "*/.cursor/skills/*/SKILL.md", "\)"],
    { encoding: "utf-8", timeout: 30000, maxBuffer: 1024 * 1024 * 8 },
    (err, stdout) => {
      if (err || !stdout.trim()) return;
      const paths = stdout.trim().split("\n").filter(Boolean);
      const skills: WorkspaceSkillEntry[] = [];
      for (const mdPath of paths) {
        const fm = parseSkillFrontmatter(mdPath);
        if (!fm) continue;
        // Derive plugin name from the directory containing .claude/ or .cursor/
        const parts = mdPath.split("/");
        const dotDirIdx = parts.findIndex((p) => p === ".claude" || p === ".cursor");
        const plugin = dotDirIdx > 0 ? parts[dotDirIdx - 1] : "workspace";
        skills.push({ name: fm.name, description: fm.description, plugin, path: mdPath });
      }
      const cache: WorkspaceSkillCache = {
        cwd,
        scannedAt: new Date().toISOString(),
        skills,
      };
      try {
        writeFileSync(workspaceSkillCachePath(cwd), JSON.stringify(cache, null, 2));
      } catch {
        // Cache write failed — non-fatal, find-skill.js will just skip workspace skills
      }
    },
  );
}

// ── Skill() tool support ─────────────────────────────────────────────────
//
// The Skill tool unifies discovery (find_skill) and invocation into one
// interface. It resolves exact names instantly via a built-in index, falls
// back to find-skill.js search for fuzzy queries, and returns the right
// invocation pattern based on skill type (workflow / agent / instruction).

interface SkillInfo {
  name: string;
  dir: string;
  description: string;
  plugin: string;
  source: "playground" | "marketplace" | "workspace";
}

// Confidence thresholds for auto-resolving search results (mirror find-skill.js)
const SKILL_LOCAL_PLUGINS = new Set(["codex", "dev-tools", "stories", "automate", "model-config", "devflow"]);
const SKILL_STRONG_REASONS = new Set(["exact name match", "trigger match", "fuzzy trigger match"]);
const SKILL_AMBIGUOUS_DELTA = 0.09;
const MAX_INSTRUCTION_CHARS = 8000;

type SkillType = "workflow" | "agent" | "instruction";

function detectSkillType(skillDir: string): SkillType {
  if (existsSync(join(skillDir, "workflow.js"))) return "workflow";
  try {
    const md = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    if (/Agent\(\s*\{/.test(md)) return "agent";
  } catch {}
  return "instruction";
}

function extractAgentType(skillMdPath: string): string | null {
  try {
    const md = readFileSync(skillMdPath, "utf-8");
    const match = md.match(/subagent_type:\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function readSkillBody(skillMdPath: string): string {
  try {
    const raw = readFileSync(skillMdPath, "utf-8");
    return raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
  } catch {
    return "";
  }
}

function buildSkillIndex(repoRoot: string): Map<string, SkillInfo> {
  const index = new Map<string, SkillInfo>();

  // 1. Playground skills (from package.json → pi.skills[])
  try {
    const raw = readFileSync(join(repoRoot, "package.json"), "utf-8");
    const pkg = parseJsonSafe<{ pi?: { skills?: string[] } }>(raw);
    for (const skillPath of pkg?.pi?.skills ?? []) {
      if (skillPath.includes("*")) continue;
      const absPath = resolve(repoRoot, skillPath);
      const skillDir = existsSync(join(absPath, "SKILL.md")) ? absPath : dirname(absPath);
      const fm = parseSkillFrontmatter(join(skillDir, "SKILL.md"));
      if (fm) {
        const pluginMatch = skillPath.match(/agents\/plugins\/([^\/]+)/);
        const plugin = pluginMatch ? pluginMatch[1] : "playground";
        index.set(fm.name, {
          name: fm.name,
          dir: skillDir,
          description: fm.description,
          plugin,
          source: "playground",
        });
      }
    }
  } catch {}

  // 2. Marketplace skills
  const marketSkills = resolveCoreDevWorkflowSkillDirs();
  if (marketSkills) {
    for (const skillDir of marketSkills.skillPaths) {
      const fm = parseSkillFrontmatter(join(skillDir, "SKILL.md"));
      if (fm && !index.has(fm.name)) {
        const plugin = basename(dirname(dirname(skillDir)));
        index.set(fm.name, {
          name: fm.name,
          dir: skillDir,
          description: fm.description,
          plugin,
          source: "marketplace",
        });
      }
    }
  }

  // 3. Workspace skills (from cache)
  const wsCache = readWorkspaceSkillCache(process.cwd());
  if (wsCache) {
    for (const entry of wsCache.skills) {
      if (!index.has(entry.name)) {
        index.set(entry.name, {
          name: entry.name,
          dir: dirname(entry.path),
          description: entry.description,
          plugin: entry.plugin ?? "workspace",
          source: "workspace",
        });
      }
    }
  }

  return index;
}

function formatSkillResponse(
  info: SkillInfo,
  args?: string,
): AgentToolResult<Record<string, unknown>> {
  const skillType = detectSkillType(info.dir);
  const skillMdPath = join(info.dir, "SKILL.md");

  if (skillType === "workflow") {
    const workflowPath = join(info.dir, "workflow.js");
    const argsPart = args ? `, args: ${JSON.stringify(args)}` : "";
    const directive = `Workflow({ scriptPath: ${JSON.stringify(workflowPath)}${argsPart} })`;
    const text =
      `Skill "${info.name}" is workflow-backed. Invoke it now:\n\n` +
      `${directive}\n\n` +
      `Description: ${info.description}`;
    return {
      content: [{ type: "text", text }],
      details: { skill: info.name, type: "workflow", action: "invoke", directive, description: info.description },
    };
  }

  if (skillType === "agent") {
    const subagentType = extractAgentType(skillMdPath) ?? `${info.plugin}:unknown`;
    const promptHint = args ? ` Context: ${args}` : "";
    const directive =
      `Agent({ subagent_type: ${JSON.stringify(subagentType)}, prompt: "<your task>${promptHint}" })`;
    const text =
      `Skill "${info.name}" is agent-backed. Invoke it with:\n\n` +
      `${directive}\n\n` +
      `Description: ${info.description}`;
    return {
      content: [{ type: "text", text }],
      details: { skill: info.name, type: "agent", action: "invoke", subagentType, description: info.description },
    };
  }

  // Instruction skill — inline the SKILL.md body
  const body = readSkillBody(skillMdPath);
  const truncated = body.length > MAX_INSTRUCTION_CHARS;
  const bodyText = truncated
    ? body.slice(0, MAX_INSTRUCTION_CHARS) +
      `\n\n[... truncated — read the full file at ${skillMdPath} for the rest]`
    : body;
  const argsLine = args ? `\n\nArgs provided: ${args}\n` : "";
  const text =
    `Skill "${info.name}" instructions — follow these steps:\n\n` +
    `${bodyText}${argsLine}`;
  return {
    content: [{ type: "text", text }],
    details: { skill: info.name, type: "instruction", action: "follow", description: info.description },
  };
}

export default function skillDiscovery(pi: ExtensionAPI) {
  const repoRoot = playgroundRoot();

  // Background-scan workspace skills on session start. Fire-and-forget —
  // the cache is written asynchronously and find-skill.js picks it up on
  // the next find_skill call. If the scan is still in flight, workspace
  // skills are simply not discoverable yet (graceful degradation).
  pi.on("session_start", async (_event, ctx) => {
    refreshWorkspaceSkillCache(ctx.cwd);
  });

  pi.on("resources_discover", async () => {
    // Lazy mode (default): contribute nothing to <available_skills>; marketplace
    // skills are reachable via the find_skill tool + the router. Full mode keeps
    // the legacy eager behavior.
    if (SKILLS_MODE !== "full") return {};
    const resolvedSkills = resolveCoreDevWorkflowSkillDirs();
    return resolvedSkills ? { skillPaths: resolvedSkills.skillPaths } : {};
  });

  // find_skill — on-demand skill discovery. Always registered, in both modes.
  pi.registerTool({
    name: "find_skill",
    label: "find skill",
    description:
      "Discover skills by intent across playground + the AIFX dev-workflow marketplace + the working directory. " +
      "Marketplace skill descriptions are kept OUT of the prompt to save context, so call " +
      "this with the user's request (or an exact skill name) to get the best matches and " +
      "their SKILL.md file paths, then read that SKILL.md and follow it. Use whenever a " +
      "request seems to match a skill you cannot see listed in <available_skills>.",
    promptSnippet: "Discover skills by intent (marketplace + playground); read SKILL.md and follow it",
    promptGuidelines: [
      "Use find_skill when a user request seems to match a skill not listed in <available_skills> — pass the user's text or an exact skill name.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The user's request, or an exact skill name (e.g. 'watch my diff' or 'babysit-diff').",
      }),
      max: Type.Optional(Type.Number({ description: "Max candidates to return (default 5, max 10)." })),
    }),
    execute: async (_id: string, params: any): Promise<AgentToolResult<Record<string, unknown>>> => {
      const query = String(params?.query ?? "").trim();
      const max = Math.max(1, Math.min(10, Number(params?.max) || 5));
      if (!query) {
        return { content: [{ type: "text", text: "find_skill: 'query' is required." }], details: { query: "", candidates: [] } };
      }
      const candidates = runFindSkill(repoRoot, query, max, process.cwd());
      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: `No skills matched "${query}".` }],
          details: { query, candidates: [] },
        };
      }
      const blocks = candidates.map(
        (c, i) =>
          `${i + 1}. ${c.name} (${c.plugin}) — score ${c.score.toFixed(2)}, ${c.reason}\n` +
          `   ${c.description}\n` +
          `   load: ${c.skillFile}`,
      );
      const text =
        `Top ${candidates.length} skill match(es) for "${query}":\n\n${blocks.join("\n\n")}\n\n` +
        `To run the best match, read its SKILL.md (the "load:" path) and follow the instructions.`;
      return {
        content: [{ type: "text", text }],
        details: { query, candidates },
      };
    },
  });

  // Skill — unified discovery + invocation. Replaces find_skill for most use
  // cases: pass an exact skill name to get the right invocation pattern
  // (Workflow / Agent / inline instructions), or pass a search query to
  // discover matching skills. find_skill is kept for backward compat.
  pi.registerTool({
    name: "Skill",
    label: "run skill",
    description:
      "Invoke a skill by exact name or discover it by search query. " +
      "For workflow-backed skills, returns the exact Workflow() call to execute. " +
      "For agent-backed skills, returns the Agent() call with the subagent_type. " +
      "For instruction skills, inlines the full SKILL.md body so you can follow the steps immediately. " +
      "Use this instead of find_skill + read(SKILL.md) when you know which skill you want. " +
      "If the name doesn't match exactly, it searches and returns candidates.",
    promptSnippet: "Run a skill by name or search query — returns the Workflow/Agent call or inline instructions",
    promptGuidelines: [
      "Use Skill({ skill: 'pre-diff' }) to invoke a known skill by name — it returns the exact Workflow/Agent call or the full instructions.",
      "Use Skill({ skill: 'fix my CI' }) to search by intent — it returns ranked candidates if no exact match.",
      "Pass args for skills that accept input: Skill({ skill: 'devflow-debug', args: 'test failure in foo_test.go' }).",
    ],
    parameters: Type.Object({
      skill: Type.String({
        description:
          "An exact skill name (e.g. 'pre-diff', 'devflow-debug') or a natural-language search query (e.g. 'fix my CI', 'clean bazel cache').",
      }),
      args: Type.Optional(Type.String({
        description: "Optional args to pass through to the skill (e.g. error message, flags, task description).",
      })),
    }),
    execute: async (_id: string, params: any): Promise<AgentToolResult<Record<string, unknown>>> => {
      const query = String(params?.skill ?? params?.query ?? "").trim();
      const skillArgs = params?.args ? String(params.args).trim() : undefined;
      if (!query) {
        return { content: [{ type: "text", text: "Skill: 'skill' parameter is required." }], details: { error: "missing skill" } };
      }

      // 1. Try exact name resolution via the built-in index
      const index = buildSkillIndex(repoRoot);
      const exact = index.get(query) ?? index.get(query.toLowerCase());
      if (exact) {
        return formatSkillResponse(exact, skillArgs);
      }

      // 2. Fall back to find-skill.js search
      const candidates = runFindSkill(repoRoot, query, 5, process.cwd());
      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: `No skill found matching "${query}". Try a different name or search query.` }],
          details: { query, candidates: [], action: "none" },
        };
      }

      // 3. If the top candidate is a strong match, auto-resolve it
      const top = candidates[0];
      const secondScore = candidates.length > 1 ? (candidates[1].score || 0) : 0;
      const margin = (top.score || 0) - secondScore;
      const isLocal = SKILL_LOCAL_PLUGINS.has(top.plugin);
      const isStrong = SKILL_STRONG_REASONS.has(top.reason);
      const score = top.score || 0;

      const autoResolve =
        (isLocal && score >= 0.72 && margin >= SKILL_AMBIGUOUS_DELTA && isStrong) ||
        (!isLocal && score >= 0.85 && margin >= 0.09 && isStrong);

      if (autoResolve) {
        // Resolve the skill dir from the candidate's skillFile path
        const skillDir = dirname(top.skillFile);
        const info: SkillInfo = {
          name: top.name,
          dir: skillDir,
          description: top.description,
          plugin: top.plugin,
          source: "playground", // find-skill.js resolves all sources; default to playground
        };
        return formatSkillResponse(info, skillArgs);
      }

      // 4. Ambiguous — return candidates like find_skill does
      const blocks = candidates.map(
        (c, i) =>
          `${i + 1}. ${c.name} (${c.plugin}) — score ${c.score.toFixed(2)}, ${c.reason}\n` +
          `   ${c.description}\n` +
          `   load: ${c.skillFile}`,
      );
      const text =
        `No exact match for "${query}". Top ${candidates.length} candidate(s):\n\n${blocks.join("\n\n")}\n\n` +
        `Call Skill({ skill: "<name>" }) with an exact name to invoke one, or read the SKILL.md at the "load:" path.`;
      return {
        content: [{ type: "text", text }],
        details: { query, candidates, action: "ambiguous" },
      };
    },
  });

  pi.registerCommand("skill-discovery", {
    description: "Show skill discovery mode + marketplace skill count",
    handler: async (_args, ctx) => {
      const resolvedSkills = resolveCoreDevWorkflowSkillDirs();
      if (!resolvedSkills) {
        ctx.ui.notify(
          "Marketplace skills not found. Run Claude/AIFX marketplace setup first (agent-marketplace), then /reload.",
          "warning",
        );
        return;
      }

      const count = resolvedSkills.skillPaths.length;

      // Also report workspace skills from the cache (if available)
      const wsCache = readWorkspaceSkillCache(process.cwd());
      const wsCount = wsCache?.skills.length ?? 0;
      const wsSuffix = wsCount > 0 ? ` + ${wsCount} workspace skills from ${process.cwd}` : "";

      if (SKILLS_MODE === "full") {
        const skipped = resolvedSkills.skippedCollisions
          .map(skill => skill.name)
          .sort()
          .join(", ");
        const suffix = skipped ? `; skipped collisions: ${skipped}` : "";
        ctx.ui.notify(
          `skill-discovery: FULL mode — ${count} marketplace skills loaded into the prompt from ${resolvedSkills.root}${suffix}${wsSuffix}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `skill-discovery: LAZY mode — ${count} marketplace skills discoverable via the find_skill tool (NOT loaded into the prompt).` +
            `${wsSuffix} Set PI_SKILLS_MODE=full to eager-load them.`,
          "info",
        );
      }
    },
  });
}
