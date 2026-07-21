/**
 * MCP Bridge Extension
 * @desc: Discovers aifx MCP servers from ~/.claude.json, caches tool lists, and
 *        registers them as native pi tools (mcp__server__tool).
 *        Commands: /mcp-tools, /mcp-refresh.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The pi runtime flags a tool result as an error only when execute() throws;
// the `isError` field on the returned object is advisory (ignored by the current
// runtime). We keep it for intent/forward-compat, so the result type allows it.
type ToolResult = AgentToolResult<Record<string, unknown>> & { isError?: boolean };
import { Type } from "typebox";
import { spawn as spawnAsync, type ChildProcess } from "child_process";
import {
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { PATHS } from "../lib/paths.ts";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";

export interface McpLocalConfig {
  directTools?: Record<string, string[]>;
  disableProxyTool?: boolean;
}

const MCP_LOCAL_PATH = PATHS.mcpLocalConfig;

function readMcpLocalConfig(): McpLocalConfig {
  try {
    const raw = readFileSync(MCP_LOCAL_PATH, "utf-8");
    const parsed = parseJsonSafe<McpLocalConfig>(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // fallthrough
  }
  return {};
}

function readMcpConfig(): Required<McpLocalConfig> {
  // PI_MCP_DIRECT_ONLY overrides the local config when set (subagent mode):
  // register ONLY the listed server/tool specs as direct tools, skip proxy.
  const override = process.env.PI_MCP_DIRECT_ONLY;
  if (override) {
    const directTools: Record<string, string[]> = {};
    for (const spec of override.split(",").map(s => s.trim()).filter(Boolean)) {
      const [server, tool] = spec.includes("/") ? spec.split("/", 2) : [spec, "*"];
      const arr = directTools[server] ?? (directTools[server] = []);
      // server-only spec means all tools (wildcard); a specific tool appends it.
      if (tool === "*") {
        directTools[server] = ["*"];
      } else if (!arr.includes("*")) {
        arr.push(tool);
      }
    }
    return { directTools, disableProxyTool: true };
  }

  const cfg = readMcpLocalConfig();
  return {
    directTools: cfg.directTools ?? {},
    disableProxyTool: cfg.disableProxyTool ?? false,
  };
}

function isDirectTool(server: string, tool: string, config: Required<McpLocalConfig>): boolean {
  const allowed = config.directTools[server];
  if (!allowed) return false;
  return allowed.includes(tool);
}

function isServerDirect(server: string, config: Required<McpLocalConfig>): boolean {
  const allowed = config.directTools[server];
  if (!allowed) return false;
  return allowed.length === 1 && allowed[0] === "*";
}

// ─── proxy tool schema ───────────────────────────────────────────────────────

const MCP_PROXY_SCHEMA = Type.Object({
  action: Type.Optional(Type.String({ description: 'One of: "search", "describe", "call", "connect", "status", "list"' })),
  server: Type.Optional(Type.String({ description: "Server name to list/connect to" })),
  search: Type.Optional(Type.String({ description: "Space-separated keywords to search MCP tools" })),
  describe: Type.Optional(Type.String({ description: "Tool name to describe (e.g. mcp__server__tool)" })),
  tool: Type.Optional(Type.String({ description: "Fully qualified tool name to call (e.g. mcp__server__tool)" })),
  args: Type.Optional(Type.String({ description: "JSON string of arguments for the tool call" })),
});

type ProxyParams = {
  action?: string;
  server?: string;
  search?: string;
  describe?: string;
  tool?: string;
  args?: string;
};

/**
 * Resolve a fully-qualified tool reference (e.g. "mcp__usearch-backend__searchv2"
 * or the sanitized form "mcp__usearch_backend__searchv2") to a server + tool pair
 * from the server cache.
 *
 * Handles hyphenated server names: `split("__")` on `mcp__usearch_backend__tool`
 * yields `serverName="usearch_backend"`, but the cache key is `"usearch-backend"`.
 * We try the exact match first, then a hyphen-restored variant (underscores → hyphens).
 * Falls back to scanning all servers by sanitized tool name.
 */
export function resolveToolRef(
  full: string,
  serverCache: Map<string, McpTool[]>,
): { server: string; tool: McpTool } | undefined {
  const parts = full.split("__");
  const toolName = parts.length >= 3 ? parts.slice(2).join("__") : full;
  const serverName = parts.length >= 3 ? parts[1] : undefined;

  if (serverName) {
    // Try exact server name first (e.g. "usearch-backend" with hyphen).
    const tools = serverCache.get(serverName);
    const t = tools?.find(x => sanitize(x.name) === toolName || x.name === toolName);
    if (t) return { server: serverName, tool: t };

    // Try hyphen-restored variant (e.g. "usearch_backend" → "usearch-backend").
    const hyphenName = serverName.replace(/_/g, "-");
    if (hyphenName !== serverName) {
      const toolsHyphen = serverCache.get(hyphenName);
      const tHyphen = toolsHyphen?.find(x => sanitize(x.name) === toolName || x.name === toolName);
      if (tHyphen) return { server: hyphenName, tool: tHyphen };
    }
  }

  // Fall back to scanning all servers by tool name match.
  for (const [server, tools] of serverCache.entries()) {
    const t = tools.find(x => sanitize(x.name) === toolName || x.name === toolName);
    if (t) return { server, tool: t };
  }
  return undefined;
}

/**
 * Extract the server name and tool name from a fully-qualified reference for
 * the `call` action, which passes them to `aifx mcp call <server> <tool>`.
 * Unlike resolveToolRef, this does NOT require the server to be in the cache —
 * it just parses the string. Tries the hyphen-restored server name as a fallback
 * so the shell command uses the correct server name.
 */
export function parseToolRefForCall(
  full: string,
  serverCache: Map<string, McpTool[]>,
): { serverName: string; toolName: string } | undefined {
  const parts = full.split("__");
  if (parts.length < 3) return undefined;
  const serverName = parts[1];
  const toolName = parts.slice(2).join("__");

  // If the server name isn't in the cache, try the hyphen-restored variant.
  if (!serverCache.has(serverName)) {
    const hyphenName = serverName.replace(/_/g, "-");
    if (serverCache.has(hyphenName)) {
      return { serverName: hyphenName, toolName };
    }
  }
  return { serverName, toolName };
}

function proxyToolExecute(
  pi: ExtensionAPI,
  registered: Set<string>,
  serverCache: Map<string, McpTool[]>,
  config: Required<McpLocalConfig>,
): (toolCallId: string, params: ProxyParams) => Promise<ToolResult> {
  return async (_toolCallId, params) => {
    // status / default
    if (!params.action || params.action === "status") {
      return executeProxyStatus(pi, registered, serverCache, config);
    }

    if (params.action === "list" || params.server) {
      const server = params.server;
      if (server) {
        const tools = serverCache.get(server);
        if (!tools) {
          return {
            content: [{ type: "text", text: `Server "${server}" not found or has no cached tools.` }],
            details: { mode: "list", error: "server_not_found" },
            isError: true,
          };
        }
        const lines = tools.map(t => `${sanitize(server)}_${sanitize(t.name)} — ${t.description ?? ""}`.slice(0, 200));
        return {
          content: [{ type: "text", text: `Server: ${server} (${tools.length} tools)\n${lines.join("\n")}` }],
          details: { mode: "list", server, count: tools.length, tools: tools.map(t => t.name) },
        };
      }
      return executeProxyStatus(pi, registered, serverCache, config);
    }

    if (params.action === "search") {
      const terms = (params.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matches: Array<{ server: string; tool: string; description: string }> = [];
      for (const [server, tools] of serverCache.entries()) {
        for (const tool of tools) {
          const hay = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
          if (terms.length === 0 || terms.some(t => hay.includes(t))) {
            matches.push({ server, tool: tool.name, description: tool.description ?? "" });
          }
        }
      }
      const lines = matches.map(m => `${sanitize(m.server)}_${sanitize(m.tool)} — ${m.description.slice(0, 120)}`);
      return {
        content: [{ type: "text", text: `MCP search (${matches.length} results):\n${lines.join("\n") || "(no matches)"}` }],
        details: { mode: "search", count: matches.length, matches },
      };
    }

    if (params.action === "describe") {
      const full = params.describe ?? params.tool ?? "";
      const found = resolveToolRef(full, serverCache);
      if (!found) {
        return {
          content: [{ type: "text", text: `Tool "${full}" not found. Use mcp({ search: "..." }).` }],
          details: { mode: "describe", error: "tool_not_found", requested: full },
          isError: true,
        };
      }
      const schema = JSON.stringify(found.tool.inputSchema ?? {}, null, 2);
      return {
        content: [{ type: "text", text: `${sanitize(found.server)}_${sanitize(found.tool.name)}\n${found.tool.description ?? ""}\n\nParameters:\n${schema}` }],
        details: { mode: "describe", server: found.server, tool: found.tool.name, schema: found.tool.inputSchema },
      };
    }

    if (params.action === "connect") {
      const server = params.server ?? params.tool ?? "";
      const r = await runAsync("aifx", ["mcp", "call", server, "--list-tools", "--json", "--no-token-savings"]);
      return {
        content: [{ type: "text", text: r.ok ? `Connected to ${server}` : `Connect failed: ${r.stderr}` }],
        details: { mode: "connect", server, ok: r.ok },
        isError: !r.ok,
      };
    }

    if (params.action === "call") {
      const full = params.tool ?? "";
      const parsed = parseToolRefForCall(full, serverCache);
      if (!parsed) {
        return {
          content: [{ type: "text", text: "Tool name must be fully qualified: mcp({ tool: \"mcp__server__tool\", args: \"{}\" })" }],
          details: { mode: "call", error: "missing_server" },
          isError: true,
        };
      }
      const { serverName, toolName } = parsed;
      const args = params.args ?? "{}";
      const r = await runAsync("aifx", ["mcp", "call", serverName, toolName, "--args", args, "--no-token-savings"]);
      if (!r.ok) {
        return {
          content: [{ type: "text", text: `Error calling ${serverName}.${toolName}:\n${r.stderr}` }],
          details: { mode: "call", server: serverName, tool: toolName, error: r.stderr },
          isError: true,
        };
      }
      const truncation = truncateHead(r.stdout, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncation.content;
      if (truncation.truncated) {
        text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Use code-mode (aifx mcp call ${serverName} ${toolName} --args '${args}' -o /tmp/file.json) for full output.]`;
      }
      return {
        content: [{ type: "text", text }],
        details: { mode: "call", server: serverName, tool: toolName, truncated: truncation.truncated },
      };
    }

    return {
      content: [{ type: "text", text: `Unknown action: ${params.action}. Use search/describe/call/connect/status/list.` }],
      details: { mode: "error", error: "unknown_action" },
      isError: true,
    };
  };
}

function executeProxyStatus(
  _pi: ExtensionAPI,
  registered: Set<string>,
  serverCache: Map<string, McpTool[]>,
  _config: Required<McpLocalConfig>,
): ToolResult {
  const lines: string[] = [];
  for (const [server, tools] of serverCache.entries()) {
    const direct = _config.directTools[server] ?? [];
    lines.push(`• ${server}: ${tools.length} tools, ${direct.length} direct`);
  }
  const directCount = Object.values(_config.directTools).reduce((s, arr) => s + arr.length, 0);
  return {
    content: [{ type: "text", text: `MCP: ${serverCache.size} servers, ${registered.size} direct tools, ${directCount} configured direct.\n${lines.join("\n")}` }],
    details: { mode: "status", servers: serverCache.size, direct: registered.size },
  };
}

// ─── constants ───────────────────────────────────────────────────────────────

const CACHE_DIR = PATHS.mcpBridgeCacheDir;
const CACHE_FILE = join(CACHE_DIR, "tools-cache.json");
const CLI_TIMEOUT_MS = 30_000;
// Self-heal window: even when ~/.claude.json is unchanged, refetch tool lists
// once a cache entry is older than this so server-side tool changes eventually
// propagate without a manual /mcp-refresh.
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days

// ─── async subprocess ────────────────────────────────────────────────────────

function runAsync(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child: ChildProcess = spawnAsync(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Async spawn streams emit Buffers; set encoding so chunks arrive as
    // strings (and multi-byte sequences aren't split across chunk boundaries).
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr: "TIMEOUT" });
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(err) });
    });
  });
}

// ─── cache ───────────────────────────────────────────────────────────────────

interface CachedServerTools {
  tools: McpTool[];
  fetchedAt: number; // ms epoch
}

interface ToolsCache {
  version: number;
  servers: Record<string, CachedServerTools>;
  configMtime: number;
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function readCache(): ToolsCache | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    return parseJsonSafe(raw);
  } catch {
    return null;
  }
}

function writeCache(cache: ToolsCache): void {
  ensureCacheDir();
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

function getConfigMtime(): number {
  try {
    // Floor to integer ms: avoids float-serialization jitter in the cache key so
    // a content-identical config doesn't spuriously invalidate (each miss costs
    // ~4.5s per aifx server fetch).
    return Math.floor(statSync(PATHS.claudeJson).mtimeMs);
  } catch {
    return 0;
  }
}

function cacheIsFresh(cache: ToolsCache | null): boolean {
  if (!cache || cache.version !== 1 || !cache.servers) return false;
  if (cache.configMtime !== getConfigMtime()) return false;
  // TTL self-heal: ignore caches whose newest entry is older than CACHE_TTL_MS.
  const fetchedTimes = Object.values(cache.servers).map((s) => s.fetchedAt ?? 0);
  const newest = fetchedTimes.length ? Math.max(...fetchedTimes) : 0;
  if (newest && Date.now() - newest > CACHE_TTL_MS) return false;
  return true;
}

// ─── config reader ───────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

function readAifxServerNames(): string[] {
  try {
    const raw = readFileSync(PATHS.claudeJson, "utf-8");
    const config = parseJsonSafe<{
      mcpServers?: Record<string, { command?: string }>;
    }>(raw);
    if (!config?.mcpServers) return [];
    return Object.entries(config.mcpServers)
      .filter(([, def]) => def.command === "aifx")
      .map(([name]) => name);
  } catch {
    return [];
  }
}

// ─── schema builder ──────────────────────────────────────────────────────────

// Gemini rejects tool schemas that contain numeric enum values or oneOf with
// integer variants. Sanitize a single property definition before passing it
// through Type.Unsafe so Gemini never sees integer enum members.
function sanitizePropDef(def: Record<string, unknown>): Record<string, unknown> {
  const out = { ...def };

  // Collapse oneOf: [{ type: "string" }, { type: "integer" }] → { type: "string" }.
  // Some MCP servers (e.g. sawmill-query) use this for proto3 enum fields that
  // accept both the string name and the numeric wire value.
  if (Array.isArray(out.oneOf)) {
    const stringVariant = (out.oneOf as Record<string, unknown>[]).find(
      (v) => v.type === "string",
    );
    if (stringVariant) {
      // Merge string variant's enum list (if any) into the top-level def.
      const merged: Record<string, unknown> = { type: "string" };
      if (Array.isArray(stringVariant.enum)) merged.enum = stringVariant.enum;
      else if (out.title) merged.title = out.title;
      if (out.description) merged.description = out.description;
      return merged;
    }
    // No string variant — drop oneOf entirely to avoid breaking Gemini.
    delete out.oneOf;
  }

  // Strip integer values from enum arrays — Gemini requires enum to be
  // TYPE_STRING but some MCP schemas include numeric wire values.
  if (Array.isArray(out.enum)) {
    const stringOnly = (out.enum as unknown[]).filter((v) => typeof v === "string");
    if (stringOnly.length > 0) out.enum = stringOnly;
    else delete out.enum; // all values were numeric — drop the constraint
  }

  return out;
}

function buildTypeboxSchema(inputSchema: Record<string, unknown> | undefined) {
  if (!inputSchema || typeof inputSchema !== "object") return Type.Object({});

  const properties = inputSchema.properties as Record<string, unknown> ?? {};
  const required = (inputSchema.required as string[]) ?? [];

  const tbProps: Record<string, unknown> = {};
  for (const [key, propDef] of Object.entries(properties)) {
    const def = sanitizePropDef(propDef as Record<string, unknown>);
    tbProps[key] = required.includes(key)
      ? Type.Unsafe(def)
      : Type.Optional(Type.Unsafe(def));
  }

  return Type.Object(tbProps as Parameters<typeof Type.Object>[0], {
    additionalProperties: true,
  });
}

// ─── name sanitization ───────────────────────────────────────────────────────

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ─── json helper ─────────────────────────────────────────────────────────────

function parseJsonSafe<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ─── tool registration helper ────────────────────────────────────────────────

type RegisterResult =
  | { name: string; count: number; tools: McpTool[] }
  | { name: string; error: true; reason?: string };

/**
 * Fetch tools for one server, register them with pi, and return the tool list.
 * Runs in one async call (no double-fetch).
 */
async function fetchServer(
  serverName: string,
  pi: ExtensionAPI,
  registered: Set<string>,
  serverCache: Map<string, McpTool[]>,
  config: Required<McpLocalConfig>,
): Promise<RegisterResult> {
  const r = await runAsync("aifx", [
    "mcp", "call", serverName,
    "--list-tools", "--json", "--no-token-savings",
  ]);

  if (!r.ok) {
    return { name: serverName, error: true, reason: r.stderr.slice(0, 120) };
  }

  const tools = parseJsonSafe<McpTool[]>(r.stdout);
  if (!Array.isArray(tools)) {
    return { name: serverName, error: true, reason: "unexpected output" };
  }

  serverCache.set(serverName, tools);

  const cfg = readMcpConfig();
  for (const tool of tools) {
    const safeName = `mcp__${sanitize(serverName)}__${sanitize(tool.name)}`;
    if (registered.has(safeName)) continue;

    // Only register directly if user explicitly listed this tool (or server wildcard) in ~/.pi/agent/mcp.json
    if (!isDirectTool(serverName, tool.name, cfg) && !isServerDirect(serverName, cfg)) {
      continue;
    }
    registered.add(safeName);

    const schema = buildTypeboxSchema(tool.inputSchema);
    const capturedServer = serverName;
    const capturedTool = tool.name;

    pi.registerTool({
      name: safeName,
      label: `${capturedServer} › ${capturedTool}`,
      description: `[MCP: ${capturedServer}] ${tool.description ?? ""}`,
      parameters: schema,
      execute: makeMcpExecute(capturedServer, capturedTool),
    });
  }

  return { name: serverName, count: tools.length, tools };
}

/**
 * Build the execute handler shared by live-registered and cache-registered
 * MCP tools. Shells out to `aifx mcp call` and wraps stdout/stderr.
 */
function makeMcpExecute(
  capturedServer: string,
  capturedTool: string,
): (toolCallId: string, params: object) => Promise<ToolResult> {
  return async function execute(_toolCallId, params) {
    const callResult = await runAsync("aifx", [
      "mcp", "call", capturedServer, capturedTool,
      "--args", JSON.stringify(params), "--no-token-savings",
    ]);

    if (!callResult.ok) {
      return {
        content: [{ type: "text", text: `Error calling ${capturedServer}.${capturedTool}:\n${callResult.stderr}` }],
        details: { server: capturedServer, tool: capturedTool, error: callResult.stderr },
        isError: true,
      };
    }

    const truncation = truncateHead(callResult.stdout, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    let text = truncation.content;
    if (truncation.truncated) {
      text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Use code-mode (aifx mcp call ${capturedServer} ${capturedTool} --args '...' -o /tmp/file.json) for full output.]`;
    }
    return {
      content: [{ type: "text", text }],
      details: { server: capturedServer, tool: capturedTool, truncated: truncation.truncated },
    };
  };
}

/**
 * Register tools from a cached entry — only direct tools configured in
 * ~/.pi/agent/mcp.json are registered as first-class pi tools.
 * Full metadata is cached for the proxy `mcp` tool.
 */
function registerFromCache(
  serverName: string,
  entry: CachedServerTools,
  pi: ExtensionAPI,
  registered: Set<string>,
  config: Required<McpLocalConfig>,
): number {
  let count = 0;
  for (const tool of entry.tools) {
    const safeName = `mcp__${sanitize(serverName)}__${sanitize(tool.name)}`;
    if (registered.has(safeName)) continue;

    if (!isDirectTool(serverName, tool.name, config) && !isServerDirect(serverName, config)) {
      continue;
    }
    registered.add(safeName);

    const schema = buildTypeboxSchema(tool.inputSchema);
    const capturedServer = serverName;
    const capturedTool = tool.name;

    pi.registerTool({
      name: safeName,
      label: `${capturedServer} › ${capturedTool}`,
      description: `[MCP: ${capturedServer}] ${tool.description ?? ""}`,
      parameters: schema,
      execute: makeMcpExecute(capturedServer, capturedTool),
    });

    count++;
  }
  return count;
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function mcpBridgeExtension(pi: ExtensionAPI) {
  const registered = new Set<string>();
  const serverCache = new Map<string, McpTool[]>();

  // ── session_start: cache-first, parallel fetch on miss ──────────────────

  pi.on("session_start", async (_event, ctx) => {
    const serverNames = readAifxServerNames();
    const config = readMcpConfig();

    if (serverNames.length === 0) {
      ctx.ui.notify("mcp-bridge: no aifx servers found in ~/.claude.json", "warning");
      return;
    }

    const cache = readCache();
    const configMtime = getConfigMtime();

    // ── cache hit: register immediately, no aifx calls ──────────────────
    if (cacheIsFresh(cache)) {
      let totalTools = 0;
      const unavailable: string[] = [];

      for (const name of serverNames) {
        const entry = cache!.servers[name];
        if (entry) {
          serverCache.set(name, entry.tools);
          totalTools += registerFromCache(name, entry, pi, registered, config);
        } else {
          unavailable.push(name);
        }
      }

      // Always register proxy unless explicitly disabled
      if (!config.disableProxyTool) {
        pi.registerTool({
          name: "mcp",
          label: "MCP",
          description: "Proxy for all MCP servers. Use mcp({ search, describe, call, connect, status, list }) to discover and invoke MCP tools without registering them all in context.",
          parameters: MCP_PROXY_SCHEMA,
          execute: proxyToolExecute(pi, registered, serverCache, config),
        });
      }

      const ok = serverNames.length - unavailable.length;
      const parts = [`mcp-bridge: ${totalTools} direct tools from ${ok}/${serverNames.length} servers (cache hit)`];
      if (unavailable.length > 0) parts.push(`(no cache: ${unavailable.join(", ")})`);
      ctx.ui.notify(parts.join(" "), unavailable.length > 0 ? "warning" : "info");
      return;
    }

    // ── cache miss: fetch all servers in parallel ────────────────────────
    const results = await Promise.all(serverNames.map((name) => fetchServer(name, pi, registered, serverCache, config)));

    // Build cache from the results we already have (no double-fetch)
    const newCache: ToolsCache = {
      version: 1,
      servers: {},
      configMtime,
    };

    let totalTools = 0;
    const failed: string[] = [];

    for (const r of results) {
      if ("error" in r) {
        failed.push(r.name);
      } else {
        totalTools += r.count;
        newCache.servers[r.name] = { tools: r.tools, fetchedAt: Date.now() };
      }
    }

    writeCache(newCache);

    if (!config.disableProxyTool) {
      pi.registerTool({
        name: "mcp",
        label: "MCP",
        description: "Proxy for all MCP servers. Use mcp({ search, describe, call, connect, status, list }) to discover and invoke MCP tools without registering them all in context.",
        promptSnippet: "Proxy for all MCP servers — discover and call any tool via mcp({ action, tool, args })",
        promptGuidelines: [
          "Use mcp({ action: \"search\", search: \"keywords\" }) to discover MCP tools, then mcp({ action: \"call\", tool: \"mcp__server__tool\", args: \"{}\" }) to invoke them.",
        ],
        parameters: MCP_PROXY_SCHEMA,
        execute: proxyToolExecute(pi, registered, serverCache, config),
      });
    }

    const ok = serverNames.length - failed.length;
    const parts = [`mcp-bridge: ${totalTools} direct tools from ${ok}/${serverNames.length} servers`];
    if (failed.length > 0) parts.push(`(unavailable: ${failed.join(", ")})`);
    ctx.ui.notify(parts.join(" "), failed.length > 0 ? "warning" : "info");
  });

  // ── /mcp-tools: scrollable picker ─────────────────────────────────────

  pi.registerCommand("mcp-tools", {
    description: "Browse direct MCP tools registered by mcp-bridge: /mcp-tools [filter]",
    handler: async (args, ctx) => {
      const filter = (args?.trim() ?? "").toLowerCase();

      const byServer = new Map<string, string[]>();
      for (const toolName of [...registered].sort()) {
        if (filter && !toolName.includes(filter)) continue;
        const parts = toolName.split("__");
        const server = parts[1] ?? "unknown";
        const arr = byServer.get(server) ?? [];
        if (!byServer.has(server)) byServer.set(server, arr);
        arr.push(toolName);
      }

      if (byServer.size === 0) {
        ctx.ui.notify(
          filter ? `No direct MCP tools matching '${filter}'` : "No direct MCP tools registered yet. Add them in ~/.pi/agent/mcp.json",
          "info",
        );
        return;
      }

      const items: string[] = [];
      for (const [server, tools] of byServer) {
        items.push(`── ${server} (${tools.length}) ──`);
        for (const t of tools) {
          items.push(`  ${t.split("__").slice(2).join("__")}`);
        }
      }

      const total = [...byServer.values()].reduce((s, t) => s + t.length, 0);
      await ctx.ui.select(`Direct MCP Tools (${total}${filter ? `, filter: ${filter}` : ""})`, items);
    },
  });

  // ── /mcp-refresh: invalidate and re-fetch ─────────────────────────────

  pi.registerCommand("mcp-refresh", {
    description: "Force re-fetch MCP server tools and update cache: /mcp-refresh",
    handler: async (_args, ctx) => {
      // Invalidate cache by setting configMtime to 0 so cacheIsFresh returns false
      const cache = readCache();
      if (cache) {
        cache.configMtime = 0;
        writeCache(cache);
      }

      const serverNames = readAifxServerNames();
      const config = readMcpConfig();
      const results = await Promise.all(serverNames.map((name) => fetchServer(name, pi, registered, serverCache, config)));

      const newCache: ToolsCache = {
        version: 1,
        servers: {},
        configMtime: getConfigMtime(),
      };

      let newTools = 0;
      const failed: string[] = [];

      for (const r of results) {
        if ("error" in r) {
          failed.push(r.name);
        } else {
          newTools += r.count;
          newCache.servers[r.name] = { tools: r.tools, fetchedAt: Date.now() };
        }
      }

      writeCache(newCache);

      if (!config.disableProxyTool) {
        pi.registerTool({
          name: "mcp",
          label: "MCP",
          description: "Proxy for all MCP servers. Use mcp({ search, describe, call, connect, status, list }) to discover and invoke MCP tools without registering them all in context.",
          parameters: MCP_PROXY_SCHEMA,
          execute: proxyToolExecute(pi, registered, serverCache, config),
        });
      }

      const parts = [`mcp-bridge: ${newTools} direct tools registered (${registered.size} total)`];
      if (failed.length > 0) parts.push(`(unavailable: ${failed.join(", ")})`);
      ctx.ui.notify(parts.join(" "), failed.length > 0 ? "warning" : "info");
    },
  });
}