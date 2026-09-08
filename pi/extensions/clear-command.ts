/**
 * clear-command — `/clear`, a fresh session in the current directory.
 *
 * pi ships `/new` variants but no `/clear`; this maps the familiar name onto
 * `newSession()`, which swaps in a brand-new session file so the context window
 * starts empty. The old session is left on disk and stays resumable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Clear the conversation and start a fresh session",
    handler: async (_args, ctx) => {
      // Starting a session mid-stream would abandon an in-flight reply, so let
      // the current turn finish first.
      await ctx.waitForIdle();

      // The captured `ctx` goes stale the moment the session is replaced, so
      // anything after the swap has to run through `withSession`'s fresh ctx.
      // Touching the outer `ctx` here raises "stale extension ctx".
      await ctx.newSession({
        withSession: async (fresh) => {
          fresh.ui.notify("Conversation cleared", "info");
        },
      });
    },
  });
}
