/**
 * pi-types.ts — Minimal shared pi extension interfaces.
 *
 * These mirror the shapes the extensions actually use from pi's
 * ExtensionAPI / ExtensionContext. Kept here so the libs and the thin
 * extensions reference one definition instead of re-declaring inline.
 *
 * No default export — library module, not a pi extension.
 */

export interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ModelDescriptor {
	id: string;
	provider: string;
}

export interface ExtensionContext {
	hasUI: boolean;
	cwd?: string;
	ui: {
		notify(msg: string, level?: string): void;
		setStatus(key: string, val: string | undefined): void;
		setWidget(key: string, lines?: string[], opts?: { placement?: string }): void;
		select<T = string>(title: string, items: string[]): Promise<T | null>;
		custom<T = any>(
			render: (
				tui: any,
				theme: Theme,
				keybindings: any,
				done: (result?: T) => void,
			) => any,
			options?: { overlay?: boolean; overlayOptions?: any; onHandle?: (h: any) => void },
		): Promise<T>;
		theme: Theme;
	};
	modelRegistry: { find(provider: string, id: string): ModelDescriptor | null };
	sessionManager: { getEntries(): any[] };
}

export interface ExtensionAPI {
	on(event: string, cb: (...args: any[]) => any): void;
	setModel(model: ModelDescriptor): Promise<boolean>;
	setThinkingLevel(level: string): void;
	getThinkingLevel(): string;
	registerCommand(name: string, spec: { description: string; handler: (...args: any[]) => any }): void;
	appendEntry(customType: string, data: unknown): void;
}
