// @desc: ctrl+f — jump between tmux sessions/windows via tmux-sessionizer.
// Opens the sessionizer in a tmux popup (overlay over pi's window). On select,
// the sessionizer runs `tmux switch-client`, moving the current tmux client to
// the chosen session/window; pi keeps running in its own window. Escaping the
// popup returns to pi unchanged.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  const launch = async () => {
    const script = join(homedir(), "tmux-sessionizer");
    await pi.exec("tmux", ["display-popup", "-E", "-w", "95%", "-h", "95%", script]);
  };

  pi.registerShortcut(Key.ctrl("f"), {
    description: "Jump to a tmux session/window (tmux-sessionizer)",
    handler: launch,
  });

  pi.registerCommand("sessionizer", {
    description: "Jump to a tmux session/window (tmux-sessionizer)",
    handler: async () => launch(),
  });
}
