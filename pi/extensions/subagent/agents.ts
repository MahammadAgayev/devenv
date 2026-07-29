/**
 * Agent discovery for the subagent tool — registry-backed.
 *
 * This is the official pi subagent example's agents.ts, adapted to source
 * agents from THIS repo's capability registry (`pi/registry/*.md`) instead of
 * `~/.pi/agent/agents/`. A registry file is a callable subagent when its
 * frontmatter declares BOTH `agent:` (the callable name) and `description:`
 * (shown to the model). The file body is the agent's system prompt.
 *
 * Registry files with only `prompt:` (no `agent:`/`description:`) stay
 * prompt-only and are handled by registry.ts — they are not subagents.
 *
 * The `AgentScope`/`projectAgentsDir` surface is kept identical to the upstream
 * example so index.ts is a verbatim copy. Registry agents are all "user" scope;
 * there is no project dir, so the project-confirmation path stays dormant.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { PATHS } from "../lib/paths.ts";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromRegistry(dir: string): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		// A registry file is a callable subagent only when it declares an agent
		// name and a description. Prompt-only files are skipped (registry.ts owns them).
		if (!frontmatter.agent || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.agent,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source: "user",
			filePath,
		});
	}

	return agents;
}

export function discoverAgents(_cwd: string, _scope: AgentScope): AgentDiscoveryResult {
	// Registry is a single directory; scope has no effect (kept for interface
	// parity with the upstream example so index.ts is unchanged).
	const agents = loadAgentsFromRegistry(PATHS.registryDir);
	return { agents, projectAgentsDir: null };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
