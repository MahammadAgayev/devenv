/**
 * paths.ts — TypeScript SSOT for playground path resolution.
 *
 * Mirrors `agents/lib/paths.sh` defaults with env-overrides, and adds the
 * TS-specific paths (~/.pi/agent, ~/.claude, ~/.cache, ~/.config, pipeline
 * dirs) that Bash scripts don't need. Every value is env-overridable so tests,
 * tools, and alternate checkouts can repoint without import-order coupling.
 *
 * Usage:
 *   import { PATHS } from "../lib/paths.ts";
 *   const runsDir = PATHS.runsDir;          // ~/.local/loop/runs (env: RUNS_DIR or legacy PIPELINE_DIR-derived path)
 *   const cli     = PATHS.projectsCli;       // <repoRoot>/pi/bin/projects
 *
 * Design notes:
 *   - `getHome()` reads `process.env.HOME` at CALL TIME (falling back to
 *     `os.homedir()`) so tests can redirect all PATHS to a temp dir by setting
 *     `process.env.HOME` — even after the module is cached by a sibling
 *     test's static import. Env vars are read at call time in getters too,
 *     so tests can repoint via `process.env.X = ...` after import (mirrors
 *     project-store's storiesDir() pattern).
 *   - No dependencies beyond node:os and node:path — importable everywhere.
 *   - Derived getters (projectsCli, storiesScript, etc.) resolve relative to
 *     repoRoot, so they work regardless of where the checkout lives.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Lazily-resolved home directory. Reads `process.env.HOME` at call time (falling
 * back to the OS home dir) so tests can redirect PATHS to a temp dir by setting
 * `process.env.HOME` before the first access — even after the module is cached
 * by a sibling test's static import.
 *
 * The old `const HOME = homedir()` was captured at module-load time and read
 * the OS home dir directly, ignoring `process.env.HOME`. That defeated every
 * PATHS getter's laziness: test overrides of `process.env.HOME` arrived too
 * late (the getter read `process.env` at call time, but `HOME` was already
 * bound to the real home). The symptom was `SESSIONS_ROOT` resolving to the
 * real `~/.pi/agent/sessions` (15k+ dirs) in tests, making every `createTask`
 * call do `readdirSync` on 15k entries — 320ms/call instead of 0.5ms.
 */
function getHome(): string {
  return process.env.HOME ?? homedir();
}

/**
 * Resolved-at-call-time path getters. Each reads its env var on every access
 * so tests/tools can override after import without module reload.
 *
 * Bash equivalents (from agents/lib/paths.sh):
 *   PLAYGROUND_ROOT, STATE_ROOT, STORIES_DIR, AUTOMATE_DIR,
 *   PROJECT_MEMORY_DIR, BABYSIT_STATE_DIR, PROJECTS_BIN,
 *   PROJECTS_RUNNER, CAPTURE_SH, SYNC_STORIES_SH
 *
 * TS-only additions (no Bash equivalent):
 *   PI_AGENT_DIR, CLAUDE_DIR, CACHE_ROOT, CONFIG_ROOT,
 *   LOOP_DIR (legacy PIPELINE_DIR also honored), RUNS_DIR, TASKS_DIR, BACKLOG_DIR
 */
export const PATHS = {
  // ── Roots ────────────────────────────────────────────────────────────────
  get repoRoot(): string {
    return process.env.PLAYGROUND_ROOT ?? join(getHome(), "playground");
  },
  get stateRoot(): string {
    return process.env.STATE_ROOT ?? join(getHome(), ".local");
  },
  get cacheRoot(): string {
    return process.env.CACHE_ROOT ?? join(getHome(), ".cache");
  },
  get configRoot(): string {
    return process.env.CONFIG_ROOT ?? join(getHome(), ".config");
  },

  // ── State subdirs (under stateRoot unless env-overridden) ────────────────
  get storiesDir(): string {
    return process.env.STORIES_DIR ?? join(this.stateRoot, "stories");
  },
  get automateDir(): string {
    return process.env.AUTOMATE_DIR ?? join(this.stateRoot, "automate");
  },
  get automateConfigDir(): string {
    return process.env.AUTOMATE_CONFIG_DIR ?? join(this.configRoot, "automate");
  },
  get memoryDir(): string {
    return process.env.PROJECT_MEMORY_DIR ?? join(this.stateRoot, "project-memory");
  },
  get babysitDir(): string {
    return process.env.BABYSIT_STATE_DIR ?? join(this.stateRoot, "babysit");
  },
  get tasksDir(): string {
    return process.env.TASKS_DIR ?? join(this.stateRoot, "tasks");
  },
  get loopDir(): string {
    return process.env.LOOP_DIR ?? process.env.PIPELINE_DIR ?? join(this.stateRoot, "loop");
  },
  get devflowDir(): string {
    return process.env.DEVFLOW_DIR ?? join(this.stateRoot, "devflow");
  },
  get pipelineDir(): string {
    return this.loopDir;
  },
  get runsDir(): string {
    return process.env.RUNS_DIR ?? join(this.loopDir, "runs");
  },
  get backlogDir(): string {
    return process.env.BACKLOG_DIR ?? join(this.stateRoot, "backlog");
  },
  /** pi-specific session state (autonomous mode, etc.) — under stateRoot. */
  get piStateDir(): string {
    return join(this.stateRoot, "pi");
  },
  /** Centralized marker directory for hook/gate sentinel files. */
  get markersDir(): string {
    return process.env.MARKERS_DIR ?? join(this.stateRoot, "markers");
  },

  // ── Harness agent dirs (not under stateRoot — harness-owned) ─────────────
  get piAgentDir(): string {
    return process.env.PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(getHome(), ".pi", "agent");
  },
  get claudeDir(): string {
    return process.env.CLAUDE_DIR ?? join(getHome(), ".claude");
  },

  // ── Derived: repo-internal tools and scripts ─────────────────────────────
  get projectsCli(): string {
    return process.env.PROJECTS_BIN ?? join(this.repoRoot, "pi", "bin", "projects");
  },
  /** Path to stories.sh (the stories skill's main script). */
  get storiesScript(): string {
    return join(this.repoRoot, "agents", "plugins", "stories", "skills", "stories",
      "scripts", "stories.sh");
  },
  /** Path to stories_publish.py. */
  get storiesPublishScript(): string {
    return join(this.repoRoot, "agents", "plugins", "stories", "skills", "stories",
      "scripts", "stories_publish.py");
  },
  get captureSh(): string {
    return process.env.CAPTURE_SH ?? join(this.repoRoot, "agents", "lib", "capture.sh");
  },
  get syncStoriesSh(): string {
    return process.env.SYNC_STORIES_SH ?? join(this.repoRoot, "agents", "lib", "sync-stories.sh");
  },

  // ── Derived: cache/config subdirs ────────────────────────────────────────
  get mcpBridgeCache(): string {
    return join(this.configRoot, "pi", "mcp-bridge", "tools-cache.json");
  },
  get mcpBridgeCacheDir(): string {
    return join(this.configRoot, "pi", "mcp-bridge");
  },
  get spendCache(): string {
    return join(this.cacheRoot, "aifx", "statusline", "spendstatus_cache.json");
  },
  get mcpLocalConfig(): string {
    return join(this.piAgentDir, "mcp.json");
  },
  /** ~/.claude.json — Claude Code's global config (NOT under claudeDir). */
  get claudeJson(): string {
    return join(getHome(), ".claude.json");
  },
  /** Claude Code known-marketplaces metadata. */
  get knownMarketplacesJson(): string {
    return join(this.claudeDir, "plugins", "known_marketplaces.json");
  },
  /** AIFX marketplace checkout root. */
  get aifxMarketplaceRoot(): string {
    return join(this.stateRoot, "share", "aifx", "marketplaces");
  },
  /** AIFX dev-workflow marketplace root (uber-code/devexp-agent-marketplace). */
  get aifxDevWorkflowMarketplace(): string {
    return join(this.aifxMarketplaceRoot, "uber-code", "devexp-agent-marketplace");
  },
  /** Observability JSONL root (unified telemetry: agent, workflow, skill). */
  get observabilityDir(): string {
    return join(this.loopDir, "observability");
  },
  /** Legacy memory cache dir (migration glue). */
  get legacyMemoryCache(): string {
    return join(this.cacheRoot, "project-memory");
  },
  /** Obsidian vault projects dir (migration glue, optional). */
  get obsidianProjectsDir(): string {
    return join(getHome(), "Documents", "Obsidian Vault", "Projects");
  },
  /** models.json candidate paths searched in order. */
  get modelsJsonCandidates(): string[] {
    return [
      join(this.repoRoot, "pi", "models.json"),
      join(this.piAgentDir, "models.json"),
    ];
  },
} as const;

// Keep a lazy home-dir accessor accessible for modules that still need it
// directly (e.g. for paths not yet centralized here). Reads process.env.HOME
// at call time so test overrides take effect.
export function getHomeDir(): string { return getHome(); }
