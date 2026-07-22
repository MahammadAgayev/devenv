/**
 * paths.ts — path resolution for the devenv pi extensions.
 *
 * Only the paths actually used by the extensions here (mcp-bridge,
 * skill-discovery, markdown-preview) are defined. Every value is
 * env-overridable so tests/tools can repoint without import-order coupling.
 *
 * `getHome()` reads `process.env.HOME` at CALL TIME (falling back to
 * `os.homedir()`) so tests can redirect all PATHS to a temp dir by setting
 * `process.env.HOME`, even after the module is cached by a sibling import.
 */

import { homedir } from "node:os";
import { join } from "node:path";

function getHome(): string {
  return process.env.HOME ?? homedir();
}

export const PATHS = {
  // ── Roots ────────────────────────────────────────────────────────────────
  get stateRoot(): string {
    return process.env.STATE_ROOT ?? join(getHome(), ".local");
  },
  get cacheRoot(): string {
    return process.env.CACHE_ROOT ?? join(getHome(), ".cache");
  },
  get configRoot(): string {
    return process.env.CONFIG_ROOT ?? join(getHome(), ".config");
  },

  // ── State subdirs ────────────────────────────────────────────────────────
  get storiesDir(): string {
    return process.env.STORIES_DIR ?? join(this.stateRoot, "stories");
  },

  // ── Harness agent dirs ───────────────────────────────────────────────────
  get piAgentDir(): string {
    return process.env.PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(getHome(), ".pi", "agent");
  },
  get claudeDir(): string {
    return process.env.CLAUDE_DIR ?? join(getHome(), ".claude");
  },

  // ── Derived: cache/config subdirs ────────────────────────────────────────
  get mcpBridgeCacheDir(): string {
    return join(this.configRoot, "pi", "mcp-bridge");
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
} as const;
