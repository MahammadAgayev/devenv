/**
 * registry.ts — capability prompt commands.
 *
 * Each `pi/registry/*.md` file is one capability: a neutral instruction body
 * plus frontmatter marking how it is exposed:
 *
 *   name:   <id>
 *   prompt: <cmd>   → /<cmd> expands the body into the current conversation
 *   agent:  <name>  → consumed by agents.ts (run in background via /agent <name>)
 *   tools:  a,b,c   → tool allowlist for the agent flavor (agents.ts)
 *   model:  <id>    → model override for the agent flavor (agents.ts, optional)
 *
 * This extension handles ONLY the prompt flavor (in-context expansion). Agents
 * are never blocking: they run exclusively in the background via agents.ts,
 * which reads the same files through lib/agents/capabilities.ts.
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
