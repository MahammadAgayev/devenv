/**
 * registry.ts — capability prompt commands.
 *
 * Each `pi/registry/*.md` file is one capability: a neutral instruction body
 * plus frontmatter marking how it is exposed:
 *
 *   name:   <id>
 *   prompt: <cmd>   → /<cmd> expands the body into the current conversation
 *   agent:  <name>  → callable subagent name (consumed by subagent/agents.ts)
 *   description:    → shown to the model when the file is a subagent
 *   tools:  a,b,c   → tool allowlist for the subagent flavor
 *   model:  <id>    → model override for the subagent flavor (optional)
 *
 * This extension handles ONLY the prompt flavor (in-context expansion). The
 * agent flavor is served by the `subagent` tool (pi/extensions/subagent/),
 * which reads the same registry files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discover } from "./lib/agents/capabilities.ts";

export default function (pi: ExtensionAPI) {
  for (const cap of discover()) {
    if (!cap.prompt) continue;
    pi.registerCommand(cap.prompt, {
      description: `${cap.name}: run in-context`,
      handler: async (args: string, _ctx: any) => {
        const scope = (args ?? "").trim();
        const text = scope ? `${cap.body}\n\nScope: ${scope}` : cap.body;
        pi.sendUserMessage(text);
      },
    });
  }
}
