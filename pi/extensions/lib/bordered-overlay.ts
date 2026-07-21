/**
 * bordered-overlay.ts — Reusable overlay pane component for pi extensions.
 *
 * Combines the common "border + padded background + inner container" pattern
 * used by /projects, /tasks, and now /pmon into a single component. This keeps
 * overlay framing consistent and avoids copy-pasting DynamicBorder + Box + Spacer
 * boilerplate in every extension.
 *
 * Usage:
 *   const pane = new BorderedOverlay(theme, { title: "Pipeline Monitor" });
 *   pane.addChild(new SelectList(...));
 *   return pane;
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "./pi-types.ts";

export interface BorderedOverlayOptions {
	title?: string;
	subtitle?: string;
	help?: string;
	paddingX?: number;
	paddingY?: number;
	innerPaddingX?: number;
	innerPaddingY?: number;
}

const defaultBg = (s: string) => `\x1b[48;5;235m${s}\x1b[0m`;

export class BorderedOverlay extends Container {
	private inner: Container;
	private box: Box;
	private theme: Theme;

	constructor(theme: Theme, options: BorderedOverlayOptions = {}) {
		super();
		this.theme = theme;
		const border = (s: string) => theme.fg("borderAccent", s);
		const bg = defaultBg;
		const paddingY = options.paddingY ?? 0;
		const innerPaddingX = options.innerPaddingX ?? 2;
		const innerPaddingY = options.innerPaddingY ?? 1;

		// Outer frame — use super.addChild so we don’t route into the (not-yet-built) inner container.
		super.addChild(new DynamicBorder(border));
		if (paddingY > 0) super.addChild(new Spacer(paddingY));

		this.box = new Box(innerPaddingX, innerPaddingY, bg);
		super.addChild(this.box);
		this.inner = new Container();
		this.box.addChild(this.inner);

		if (options.title) {
			this.inner.addChild(new Text(theme.fg("accent", theme.bold(options.title)), innerPaddingX, innerPaddingY > 0 ? 0 : 1, bg));
		}
		if (options.subtitle) {
			this.inner.addChild(new Text(theme.fg("muted", options.subtitle), innerPaddingX, 0, bg));
		}
		if (options.title || options.subtitle) {
			this.inner.addChild(new Spacer(1));
		}

		if (options.help) {
			this.inner.addChild(new Spacer(1));
			this.inner.addChild(new Text(theme.fg("dim", options.help), innerPaddingX, 0, bg));
		}

		if (paddingY > 0) super.addChild(new Spacer(paddingY));
		super.addChild(new DynamicBorder(border));
	}

	addChild(component: any): void {
		this.inner.addChild(component);
	}

	override clear(): void {
		// Rebuild the inner container so external children can still be added after clear.
		this.box.clear();
		this.inner = new Container();
		this.box.addChild(this.inner);
	}
}
