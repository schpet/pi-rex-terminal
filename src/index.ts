/**
 * Press `$` in an empty Pi editor to enter a fresh Rex shell for one visit.
 * Returns after one command in fish, bash, and zsh. Ctrl+] returns manually.
 *
 * Snapshot polling is a proof of concept, not a complete terminal emulator.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { CustomEditor, type ExtensionAPI, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	type EditorTheme,
	isKeyRelease,
	matchesKey,
	parseKey,
	sliceByColumn,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { closeIfPresent, initializeVisit, ShellVisit } from "./shell-visit.ts";

const blocksReply = Type.Object({
	blocks: Type.Array(
		Type.Object({
			block_id: Type.String(),
			label: Type.String(),
			flavor: Type.String(),
			placement: Type.String(),
		}),
	),
});
const newBlockReply = Type.Object({
	block_id: Type.Union([Type.String(), Type.Null()]),
	revision: Type.Integer(),
});
const formatReply = Type.Object({ content: Type.String() });
const writeReply = Type.Object({ bytes_written: Type.Integer() });
const processReply = Type.Object({
	last_exit: Type.Union([Type.Null(), Type.Object({ exit_code: Type.Integer() })]),
	foreground: Type.Optional(Type.Union([Type.Null(), Type.Object({ name: Type.String() })])),
});
const statusReply = Type.Object({
	records: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String()),
			app: Type.Optional(Type.String()),
		}),
	),
});
const startupReply = Type.Object({
	shell: Type.Optional(Type.String()),
	initial: Type.String(),
	vt: Type.String(),
	app: Type.Optional(Type.String()),
});
const blobReply = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	data: Type.String(),
	total: Type.Integer({ minimum: 0 }),
	eof: Type.Boolean(),
});
type Snapshot = { kind: "blob"; id: number } | { kind: "inline"; content: string };
const transcriptDetails = Type.Object({
	transcript: Type.String(),
	note: Type.String(),
});
const TERMINAL_FLAVOR = "com.superlogical.terminal.shell";
const MAX_CONTEXT_CHARS = 32_000;
const runFile = promisify(execFile);
const startupScript = readFileSync(new URL("./startup.lua", import.meta.url), "utf8");

function errorText(error: unknown): string {
	if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(errorText).join("; ")}`;
	return error instanceof Error ? error.message : String(error);
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

function parseSnapshot(token: string): Snapshot {
	if (token === "empty") return { kind: "inline", content: "" };
	const blob = /^blob-([1-9]\d*)$/.exec(token);
	if (blob) {
		const id = Number(blob[1]);
		if (!Number.isSafeInteger(id)) throw new Error("Invalid Rex snapshot ID");
		return { kind: "blob", id };
	}
	const character = /^char-(\d+)$/.exec(token);
	if (character) {
		const byte = Number(character[1]);
		if (!Number.isInteger(byte) || byte < 0 || byte > 127) throw new Error("Invalid inline Rex snapshot");
		return { kind: "inline", content: String.fromCharCode(byte) };
	}
	throw new Error(`Invalid Rex snapshot token: ${token}`);
}

function parseCompletion(app: string): { count: number; snapshot: Snapshot } {
	const match = /^pi-rex-(\d+)-(.+)$/.exec(app);
	if (!match) throw new Error("Invalid Rex shell completion counter");
	const count = Number(match[1]);
	if (!Number.isSafeInteger(count)) throw new Error("Rex shell completion counter overflowed");
	return { count, snapshot: parseSnapshot(match[2]) };
}

function parseCursor(vt: string): RexCursor {
	const match = /((?:\r\n)*)\x1b\[(\d+);(\d+)H$/.exec(vt);
	if (!match) throw new Error("Rex VT snapshot did not end with a cursor position");
	const row = Number(match[2]);
	const column = Number(match[3]);
	if (!Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(column) || column < 1) {
		throw new Error("Rex returned an invalid cursor position");
	}
	return { row, column, trailingBlankLines: match[1].length / 2 };
}

function shellBytes(data: string): string {
	if (isKeyRelease(data)) return "";
	const printable = decodeKittyPrintable(data);
	if (printable !== undefined) return printable;

	const key = parseKey(data);
	switch (key) {
		case "enter":
		case "shift+enter":
			return "\r";
		case "backspace":
			return "\x7f";
		case "tab":
			return "\t";
		case "shift+tab":
			return "\x1b[Z";
		case "escape":
			return "\x1b";
		case "up":
			return "\x1b[A";
		case "down":
			return "\x1b[B";
		case "right":
			return "\x1b[C";
		case "left":
			return "\x1b[D";
		case "home":
			return "\x1b[H";
		case "end":
			return "\x1b[F";
		case "delete":
			return "\x1b[3~";
		case "pageUp":
			return "\x1b[5~";
		case "pageDown":
			return "\x1b[6~";
		case "ctrl+space":
			return "\x00";
		case "ctrl+\\":
			return "\x1c";
		case "ctrl+-":
			return "\x1f";
		default:
			break;
	}

	const controlLetter = /^ctrl\+([a-z])$/.exec(key ?? "");
	if (controlLetter) return String.fromCharCode(controlLetter[1].charCodeAt(0) - 96);
	const altLetter = /^alt\+([a-z0-9])$/.exec(key ?? "");
	if (altLetter) return `\x1b${altLetter[1]}`;
	if (key === "alt+backspace") return "\x1b\x7f";

	// Unknown Kitty or modifyOtherKeys sequences are not understood by ordinary shells.
	if (/^\x1b\[(?:\d|;|:)+u$/.test(data) || /^\x1b\[27;\d+;\d+~$/.test(data)) return "";
	return data;
}

export interface RexTerminal {
	blockId: string;
	screen(): Promise<string>;
	cursor(): Promise<RexCursor>;
	write(data: string): Promise<void>;
	resize(columns: number, rows: number): Promise<void>;
	exited(): Promise<boolean>;
	exists(): Promise<boolean>;
	completion(): Promise<number | undefined>;
	completedScreen(): Promise<string>;
	close(): Promise<void>;
}

interface RexCursor {
	row: number;
	column: number;
	trailingBlankLines: number;
}

function cursorCell(text: string): string {
	return `\x1b[7m${text}\x1b[27m`;
}

export default function (pi: ExtensionAPI) {
	const editors = new Set<RexInputEditor>();
	let stopped = false;
	async function disposeEditors(): Promise<void> {
		const results = await Promise.allSettled([...editors].map((editor) => editor.disposeShell()));
		editors.clear();
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length) throw new AggregateError(errors, "Rex editor cleanup failed");
	}
	pi.registerMessageRenderer("rex-inline-terminal", (message, { expanded, outputPad }, theme) => {
		const details = message.details === undefined ? undefined : Parse(transcriptDetails, message.details);
		const text = details?.transcript ?? (typeof message.content === "string" ? message.content : "");
		return {
			render(width) {
				const preview = truncateToVisualLines(text, expanded ? Infinity : 20, width, outputPad);
				const hidden = preview.skippedCount;
				return [
					theme.fg("bashMode", "─".repeat(width)),
					...preview.visualLines,
					...(hidden
						? [
								truncateToWidth(
									theme.fg("muted", ` ... ${hidden} more lines (`) +
										keyHint("app.tools.expand", "to expand") +
										theme.fg("muted", ")"),
									width,
								),
							]
						: []),
					...(details?.note ? new Text(theme.fg("muted", details.note), outputPad, 0).render(width) : []),
					theme.fg("bashMode", "─".repeat(width)),
				];
			},
			invalidate() {},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await disposeEditors();
		stopped = false;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new RexInputEditor(
				tui,
				theme,
				keybindings,
				async (columns, rows, signal) => {
					const sessionId = process.env.REX_SESSION;
					const piBlockId = process.env.REX_BLOCK;
					if (!sessionId || !piBlockId) throw new Error("Pi must run inside a Rex terminal");
					const selectedSessionId = sessionId;

					async function rex(args: string[], cancellation?: AbortSignal): Promise<string> {
						try {
							const result = await runFile("rex", args, {
								timeout: 10_000,
								maxBuffer: 4 * 1024 * 1024,
								encoding: "utf8",
								signal: cancellation,
							});
							return result.stdout;
						} catch (error) {
							cancellation?.throwIfAborted();
							throw new Error(`rex ${args[0]} failed: ${errorText(error)}`, {
								cause: error,
							});
						}
					}

					async function exists(id: string): Promise<boolean> {
						const current = Parse(
							blocksReply,
							JSON.parse(await rex(["block", "ls", "-s", selectedSessionId, "--json"])),
						);
						return current.blocks.some((block) => block.block_id === id);
					}
					async function close(id: string): Promise<void> {
						await closeIfPresent(
							async () => {
								await rex(["block", "close", "-s", selectedSessionId, id]);
							},
							() => exists(id),
						);
					}
					const label = `pi-inline-${piBlockId.slice("block:".length)}-${randomBytes(8).toString("hex")}`;
					let blockId: string;
					signal.throwIfAborted();
					try {
						const created = Parse(
							newBlockReply,
							JSON.parse(
								await rex([
									"api",
									"call",
									"-s",
									sessionId,
									"session.new_block",
									JSON.stringify({
										flavor: TERMINAL_FLAVOR,
										label,
										options: { cwd: ctx.cwd, size: { columns, rows } },
									}),
								]),
							),
						);
						if (!created.block_id) throw new Error("Rex did not return a terminal block ID");
						blockId = created.block_id;
					} catch (allocationError) {
						// A timed-out allocation may already have succeeded on the server.
						try {
							const recovered = Parse(
								blocksReply,
								JSON.parse(await rex(["block", "ls", "-s", sessionId, "--json"])),
							);
							for (const block of recovered.blocks.filter((block) => block.label === label))
								await close(block.block_id);
						} catch (cleanupError) {
							throw new AggregateError(
								[allocationError, cleanupError],
								`Allocation and recovery failed for ${label}`,
							);
						}
						throw allocationError;
					}
					const selectedBlockId = blockId;
					const completionId = `pi-rex-${randomBytes(8).toString("hex")}`;
					let completedSnapshot: Snapshot | undefined;
					async function call(method: string, args: object): Promise<string> {
						return rex([
							"block",
							"call",
							"-s",
							selectedSessionId,
							"-b",
							selectedBlockId,
							method,
							JSON.stringify(args),
						]);
					}
					const terminal: RexTerminal = {
						blockId: selectedBlockId,
						async screen() {
							return Parse(formatReply, JSON.parse(await call("format", { format: "text", trim: true })))
								.content;
						},
						async cursor() {
							const vt = Parse(
								formatReply,
								JSON.parse(await call("format", { format: "vt", extra_cursor: true })),
							).content;
							return parseCursor(vt);
						},
						async write(data) {
							const reply = Parse(writeReply, JSON.parse(await call("write", { data })));
							if (reply.bytes_written !== Buffer.byteLength(data))
								throw new Error("Rex wrote fewer bytes than requested");
						},
						async resize(nextColumns, nextRows) {
							await call("resize", { columns: nextColumns, rows: nextRows });
						},
						async exited() {
							return Parse(processReply, JSON.parse(await call("process", {}))).last_exit !== null;
						},
						async exists() {
							return exists(selectedBlockId);
						},
						async close() {
							await close(selectedBlockId);
						},
						async completion() {
							const status = Parse(statusReply, JSON.parse(await call("program_status", {})));
							const app = status.records.find((record) => record.id === completionId)?.app;
							if (app === undefined) return undefined;
							const completion = parseCompletion(app);
							completedSnapshot = completion.snapshot;
							return completion.count;
						},
						async completedScreen() {
							const snapshot = completedSnapshot;
							if (!snapshot) throw new Error("Rex has not reported a completed snapshot");
							if (snapshot.kind === "inline") return snapshot.content;
							let content = "";
							let offset = 0;
							for (;;) {
								const chunk = Parse(
									blobReply,
									JSON.parse(
										await call("blob_read", {
											id: snapshot.id,
											offset,
											max_bytes: 960 * 1024,
										}),
									),
								);
								if (chunk.id !== snapshot.id) throw new Error("Rex returned a different snapshot");
								if (chunk.total > 4 * 1024 * 1024) throw new Error("Completed Rex snapshot exceeds 4 MiB");
								const bytes = Buffer.byteLength(chunk.data);
								if (offset + bytes > chunk.total || (!chunk.eof && bytes === 0))
									throw new Error("Rex snapshot did not make progress");
								content += chunk.data;
								offset += bytes;
								if (chunk.eof) {
									if (offset !== chunk.total) throw new Error("Incomplete Rex snapshot");
									return content;
								}
							}
						},
					};
					return initializeVisit(
						async () => {
							// Freeze output inside the prompt hook, before the next prompt is drawn.
							// Rex keeps this immutable result for blob_read, even after the screen changes.
							const freeze = [
								"local ready=false;",
								"for attempt=1,500 do",
								'local s=rex.block.call("com.superlogical.terminal","program_status",{});',
								`for _,r in ipairs(s.records) do if r.id=="${completionId}/capture" and r.app=="pi-rex-"..tostring(rex.args.count) then ready=true; break end end;`,
								"if ready then break end; rex.sleep(0.01) end;",
								'assert(ready,"terminal did not acknowledge output boundary");',
								'local r=rex.block.call("com.superlogical.terminal","format",{format="text",trim=true,max_bytes=1});',
								'if r.id then print("blob-"..r.id) elseif r.content=="" then print("empty") else assert(#r.content==1,"invalid inline snapshot"); print("char-"..string.byte(r.content)) end',
							].join(" ");
							const snapshotCommand = `command ${["rex", "--timeout", "3s", "do", "-s", selectedSessionId, "-b", selectedBlockId, "-e", freeze].map(shellQuote).join(" ")} count="$__pi_rex_count" </dev/null`;
							// This marker travels through the PTY after the command's final bytes.
							// Wait for Rex to parse it before freezing, rather than racing the PTY reader.
							const barrier = `printf '\\033]7501;state=working:id=${completionId}/capture:app=pi-rex-%s\\007'`;
							const report = `printf '\\033]7501;state=done:id=${completionId}:app=pi-rex-%s-%s\\007'`;
							const setups = {
								fish: `set -g __pi_rex_count 0; function __pi_rex_done --on-event fish_postexec; set -g __pi_rex_had_postexec 1; set -g __pi_rex_count (math $__pi_rex_count + 1); ${barrier} $__pi_rex_count; set -l __pi_rex_snapshot (${snapshotCommand}); ${report} $__pi_rex_count "$__pi_rex_snapshot"; end; function __pi_rex_prompt --on-event fish_prompt; if not set -q __pi_rex_had_postexec; __pi_rex_done; end; set -e __pi_rex_had_postexec; end; set -gx PAGER cat; set -gx GIT_PAGER cat; set -gx GH_PAGER cat`,
								zsh: `__pi_rex_count=0; function __pi_rex_done() { (( ++__pi_rex_count )); ${barrier} "$__pi_rex_count"; local __pi_rex_snapshot; __pi_rex_snapshot=$(${snapshotCommand}) || __pi_rex_snapshot=failed; ${report} "$__pi_rex_count" "$__pi_rex_snapshot"; }; precmd_functions=(__pi_rex_done \${precmd_functions:#__pi_rex_done}); export PAGER=cat GIT_PAGER=cat GH_PAGER=cat`,
								bash: `__pi_rex_count=0; __pi_rex_done() { local s=$?; __pi_rex_count=$((__pi_rex_count+1)); ${barrier} "$__pi_rex_count"; local __pi_rex_snapshot; __pi_rex_snapshot=$(${snapshotCommand}) || __pi_rex_snapshot=failed; ${report} "$__pi_rex_count" "$__pi_rex_snapshot"; return "$s"; }; if [[ "\${PROMPT_COMMAND-}" != *"__pi_rex_done"* ]]; then PROMPT_COMMAND="__pi_rex_done\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi; export PAGER=cat GIT_PAGER=cat GH_PAGER=cat`,
							};
							const started = Parse(
								startupReply,
								JSON.parse(
									await rex(
										[
											"do",
											"-s",
											selectedSessionId,
											"-b",
											selectedBlockId,
											"-e",
											startupScript,
											"--json",
											"--args",
											JSON.stringify({ setups, completion_id: completionId }),
										],
										signal,
									),
								),
							);
							if (started.app === undefined) {
								ctx.ui.notify(
									`Automatic return is unavailable for ${started.shell ?? "this shell"}; use Ctrl+]`,
									"info",
								);
							}
							return {
								terminal,
								initial: started.initial,
								initialCursor: parseCursor(started.vt),
								baseline: started.initial,
								completion: started.app === undefined ? undefined : parseCompletion(started.app).count,
							};
						},
						() => terminal.close(),
						signal,
					);
				},
				async (terminal, baseline, fallback, source) => {
					let exists = await terminal.exists();
					let after = fallback;
					if (exists && source === "current") {
						try {
							after = await terminal.screen();
						} catch (error) {
							if (await terminal.exists()) throw error;
							exists = false;
						}
					}
					if (after === baseline && exists) return;
					const isAppend = after.startsWith(baseline);
					const changed = isAppend ? after.slice(Math.max(0, baseline.lastIndexOf("\n") + 1)) : after;
					const clipped = changed.length > MAX_CONTEXT_CHARS;
					const transcript = clipped ? changed.slice(-MAX_CONTEXT_CHARS) : changed;
					if (stopped) return;
					pi.sendMessage(
						{
							customType: "rex-inline-terminal",
							content: `User's interactive Rex terminal transcript (exit codes are unavailable):\n${exists ? "" : "[Rex shell exited; final output may be missing]\n"}${isAppend ? "" : "[screen changed; earlier terminal activity may be repeated]\n"}${clipped ? "[earlier output omitted]\n" : ""}\`\`\`text\n${transcript}\n\`\`\``,
							display: true,
							details: {
								transcript,
								note: `${exists ? "" : "Shell exited; final output may be missing. "}${clipped ? "Earlier output omitted. " : ""}${isAppend ? "" : "Screen redrawn; earlier activity may repeat. "}`,
							},
						},
						{ triggerTurn: false },
					);
				},
				(message) => {
					if (!stopped) ctx.ui.notify(`Inline Rex terminal: ${message}`, "error");
				},
			);
			editors.add(editor);
			return editor;
		});
	});
	pi.on("session_shutdown", async () => {
		stopped = true;
		await disposeEditors();
	});
}

export interface OpenedTerminal {
	terminal: RexTerminal;
	initial: string;
	initialCursor: RexCursor;
	baseline: string;
	completion: number | undefined;
}

export class RexInputEditor extends CustomEditor {
	private completion: number | undefined;
	private submissions = 0;
	private readonly open: (columns: number, rows: number, signal: AbortSignal) => Promise<OpenedTerminal>;
	private readonly capture: (
		terminal: RexTerminal,
		baseline: string,
		fallback: string,
		source: "current" | "completed",
	) => Promise<void>;
	private readonly reportError: (message: string) => void;
	private mode: "prompt" | "opening" | "shell" | "closing" = "prompt";
	private terminal: RexTerminal | undefined;
	private baseline = "";
	private content = "";
	private cursor: RexCursor | undefined;
	private pendingInput = "";
	private pendingWrite: Promise<void> | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private visit: ShellVisit<OpenedTerminal> | undefined;
	private finishing: Promise<void> | undefined;
	private disposed = false;
	private pollCount = 0;
	private columns = 80;
	private rows = 5;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		open: (columns: number, rows: number, signal: AbortSignal) => Promise<OpenedTerminal>,
		capture: (
			terminal: RexTerminal,
			baseline: string,
			fallback: string,
			source: "current" | "completed",
		) => Promise<void>,
		reportError: (message: string) => void,
	) {
		super(tui, theme, keybindings);
		this.open = open;
		this.capture = capture;
		this.reportError = reportError;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.mode === "prompt") {
			if (this.getText().length === 0 && (data === "$" || decodeKittyPrintable(data) === "$")) {
				this.mode = "opening";
				this.tui.requestRender();
				void this.activate();
				return;
			}
			super.handleInput(data);
			return;
		}
		if (matchesKey(data, "ctrl+]")) {
			void this.detach();
			return;
		}
		if (this.mode === "closing") return;
		const bytes = shellBytes(data);
		if (!bytes) return;
		this.pendingInput += bytes;
		this.submissions += bytes.split("\r").length - 1;
		if (this.mode === "shell") this.flush();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(2, width - 2);
		const rows = Math.min(20, Math.max(3, this.tui.terminal.rows - 8));
		if (innerWidth !== this.columns || rows !== this.rows) {
			this.columns = innerWidth;
			this.rows = rows;
			if (this.mode === "shell" && this.terminal) {
				const terminal = this.terminal;
				const visit = this.visit;
				void terminal.resize(this.columns, this.rows).then(
					() => {
						if (visit && this.isShell(visit)) return this.refresh();
					},
					(error: unknown) => {
						if (visit) this.fail(error, visit);
					},
				);
			}
		}
		if (this.mode === "prompt") return super.render(width);
		if (width < 4) return [truncateToWidth("Rex", width, "")];
		const lines = this.content.split("\n");
		const absoluteCursor = this.cursor
			? lines.length + this.cursor.trailingBlankLines - rows + this.cursor.row - 1
			: -1;
		while (lines.length <= absoluteCursor) lines.push("");
		const limit = rows;
		const hidden = Math.max(0, lines.length - limit);
		const body = lines.slice(-limit);
		const cursorIndex = absoluteCursor - Math.max(0, lines.length - limit);
		const label =
			this.mode === "opening"
				? "─ Starting… "
				: this.mode === "closing"
					? "─ Closing… "
					: this.submissions > 1
						? "─ multiple lines · Ctrl+] return "
						: "─ Ctrl+] return ";
		const title = truncateToWidth(label, innerWidth, "");
		return [
			`╭${title}${"─".repeat(innerWidth - visibleWidth(title))}╮`,
			...body.map((raw, index) => {
				let line = truncateToWidth(raw, innerWidth, "");
				if (this.mode === "shell" && this.cursor && cursorIndex === index) {
					const column = Math.max(0, Math.min(innerWidth - 1, this.cursor.column - 1));
					const before = sliceByColumn(line, 0, column);
					const gap = " ".repeat(Math.max(0, column - visibleWidth(before)));
					const cell = sliceByColumn(line, column, 1) || " ";
					const after = sliceByColumn(line, column + visibleWidth(cell), innerWidth - column - visibleWidth(cell));
					line = before + gap + (this.focused ? CURSOR_MARKER : "") + cursorCell(cell) + after;
				}
				return `│${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}│`;
			}),
			...(hidden
				? [truncateToWidth(`│ … ${hidden} earlier lines (Ctrl+O expands captured output)`, width, "")]
				: []),
			`╰${"─".repeat(innerWidth)}╯`,
		];
	}

	private async activate(): Promise<void> {
		const columns = this.columns;
		const rows = this.rows;
		const visit = new ShellVisit(
			(signal) => this.open(columns, rows, signal),
			(opened) => opened.terminal.close(),
		);
		this.visit = visit;
		let opened: OpenedTerminal | undefined;
		try {
			opened = await visit.ready();
			if (!opened || this.visit !== visit || this.disposed || this.mode !== "opening") return;
			if (this.columns !== columns || this.rows !== rows) {
				await opened.terminal.resize(this.columns, this.rows);
				if (this.visit !== visit || this.disposed || this.mode !== "opening") return;
				opened.initial = await opened.terminal.screen();
				if (this.visit !== visit || this.disposed || this.mode !== "opening") return;
				opened.initialCursor = await opened.terminal.cursor();
				if (this.visit !== visit || this.disposed || this.mode !== "opening") return;
				if (opened.completion !== undefined) opened.completion = await opened.terminal.completion();
			}
			if (this.visit !== visit || this.disposed || this.mode !== "opening") return;
			this.terminal = opened.terminal;
			this.baseline = opened.baseline;
			this.content = opened.initial;
			this.cursor = opened.initialCursor;
			this.completion = opened.completion;
			this.mode = "shell";
			this.pollCount = 0;
			this.pollTimer = setInterval(() => {
				if (!visit.reading) void this.refresh();
			}, 220);
			this.tui.requestRender();
			this.flush();
		} catch (error) {
			if (this.visit !== visit || this.disposed || this.mode !== "opening") return;
			if (opened) this.reportError(errorText(error));
			// Disposal observes the shared cleanup promise if shutdown races this path.
			void this.detach();
		}
	}

	private isShell(visit: ShellVisit<OpenedTerminal>): boolean {
		return !this.disposed && this.visit === visit && this.mode === "shell";
	}

	private async refresh(): Promise<void> {
		const visit = this.visit;
		const terminal = this.terminal;
		if (!visit || !terminal || !this.isShell(visit)) return;
		if (visit.reading) {
			visit.refreshAgain = true;
			return;
		}
		visit.reading = true;
		try {
			const [next, cursor] = await Promise.all([terminal.screen(), terminal.cursor()]);
			if (!this.isShell(visit)) return;
			if (
				next !== this.content ||
				cursor.row !== this.cursor?.row ||
				cursor.column !== this.cursor.column ||
				cursor.trailingBlankLines !== this.cursor.trailingBlankLines
			) {
				this.content = next;
				this.cursor = cursor;
				this.tui.requestRender();
			}
			this.pollCount++;
			// Typeahead or a pasted script can queue another command behind the first.
			// Stay attached rather than hiding a command that may still be running.
			if (this.submissions === 1 && this.completion !== undefined) {
				const completion = await terminal.completion();
				if (!this.isShell(visit)) return;
				if (completion !== undefined && completion > this.completion) {
					const completed = await terminal.completedScreen();
					if (!this.isShell(visit)) return;
					this.content = completed;
					void this.detach("completed");
					return;
				}
			}
			if (this.pollCount % 4 === 0 && (await terminal.exited()) && this.isShell(visit)) void this.detach();
		} catch (error) {
			await this.handleTerminalError(error, visit, terminal);
		} finally {
			visit.reading = false;
			if (visit.refreshAgain && this.isShell(visit)) {
				visit.refreshAgain = false;
				void this.refresh();
			}
		}
	}

	private flush(): void {
		const terminal = this.terminal;
		const visit = this.visit;
		if (this.pendingWrite || !this.pendingInput || !terminal || !visit || this.disposed) return;
		const writing: Promise<void> = Promise.resolve().then(async () => {
			try {
				// Reads may be slow; only previous writes can hold up input. Keys that
				// arrive during a write join the next batch instead of another promise.
				while (this.pendingInput && this.visit === visit && !this.disposed) {
					const data = this.pendingInput;
					this.pendingInput = "";
					await terminal.write(data);
					if (this.isShell(visit)) void this.refresh();
				}
			} catch (error) {
				if (this.visit === visit && this.mode === "closing") throw error;
				await this.handleTerminalError(error, visit, terminal);
			} finally {
				// Release the drain in this continuation, before another key can
				// arrive. Closing retains the promise so capture observes failures.
				if (this.pendingWrite === writing && this.mode !== "closing") this.pendingWrite = undefined;
			}
		});
		this.pendingWrite = writing;
	}

	private detach(source: "current" | "completed" = "current"): Promise<void> {
		if (this.finishing) return this.finishing;
		const visit = this.visit;
		if (!visit || this.mode === "prompt") return Promise.resolve();
		const capture = this.mode === "shell" && !this.disposed;
		this.mode = "closing";
		if (capture) this.flush();
		else this.pendingInput = "";
		if (this.pollTimer) clearInterval(this.pollTimer);
		const finishing = visit
			.finish(async (opened) => {
				await this.pendingWrite;
				if (capture && !this.disposed) await this.capture(opened.terminal, this.baseline, this.content, source);
			})
			.catch((error: unknown) => {
				if (this.disposed) throw error;
				this.reportError(errorText(error));
			})
			.finally(() => {
				if (this.visit !== visit) return;
				this.terminal = undefined;
				this.visit = undefined;
				this.finishing = undefined;
				this.pendingWrite = undefined;
				this.pendingInput = "";
				this.content = "";
				this.cursor = undefined;
				this.mode = "prompt";
				this.submissions = 0;
				if (!this.disposed) this.tui.requestRender();
			});
		this.finishing = finishing;
		if (!this.disposed) this.tui.requestRender();
		return finishing;
	}

	private fail(error: unknown, visit: ShellVisit<OpenedTerminal>): void {
		if (!this.isShell(visit)) return;
		this.reportError(errorText(error));
		void this.detach();
	}

	private async handleTerminalError(
		error: unknown,
		visit: ShellVisit<OpenedTerminal>,
		terminal: RexTerminal,
	): Promise<void> {
		if (!this.isShell(visit)) return;
		try {
			const exists = await terminal.exists();
			if (!this.isShell(visit)) return;
			if (!exists) {
				void this.detach();
			} else {
				this.fail(error, visit);
			}
		} catch {
			this.fail(error, visit);
		}
	}

	disposeShell(): Promise<void> {
		this.disposed = true;
		return this.detach();
	}
}
