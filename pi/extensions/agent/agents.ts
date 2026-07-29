/**
 * Agent discovery for the `agent` tool family — registry-backed.
 *
 * Adapted from the official pi subagent example's agents.ts to source agents
 * from THIS repo's capability registry (`pi/registry/*.md`) instead of
 * `~/.pi/agent/agents/`. A registry file is a callable agent when its
 * frontmatter declares BOTH `agent:` (the callable name) and `description:`
 * (shown to the model). The file body is the agent's system prompt. Optional
 * frontmatter: `tools:` (comma-separated allowlist) and `model:` (model id
 * override, passed through as `--model`).
 *
 * Registry files with only `prompt:` (no `agent:`/`description:`) stay
 * prompt-only and are handled by registry.ts — they are not agents.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { PATHS } from "../lib/paths.ts";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
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

		// A registry file is a callable agent only when it declares an agent name
		// and a description. Prompt-only files are skipped (registry.ts owns them).
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

export function discoverAgents(): AgentConfig[] {
	// Registry is a single directory (PATHS.registryDir).
	return loadAgentsFromRegistry(PATHS.registryDir);
}
