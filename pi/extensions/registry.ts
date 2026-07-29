/**
 * registry.ts — capability prompt commands.
 *
 * Each `pi/registry/*.md` file is one capability: a neutral instruction body
 * plus frontmatter marking how it is exposed:
 *
 *   name:   <id>
 *   prompt: <cmd>   → /<cmd> expands the body into the current conversation
 *   agent:  <name>  → callable agent name (consumed by agent/agents.ts)
 *   description:    → shown to the model when the file is an agent
 *   tools:  a,b,c   → tool allowlist for the agent flavor
 *   model:  <id>    → model override for the agent flavor (optional)
 *
 * This extension handles ONLY the prompt flavor (in-context expansion). The
 * agent flavor is served by the `agent` tool family (pi/extensions/agent/),
 * which reads the same registry files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discover } from "./lib/capabilities.ts";

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
