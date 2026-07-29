/**
 * pi-invocation.ts — resolve how to re-invoke `pi` for a subprocess.
 *
 * Shared by the subagent tool and the background-agent runtime so both spawn
 * child `pi` processes the same way. Prefers re-running the current script under
 * the current runtime (dev), falls back to the `pi` binary on PATH.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}
