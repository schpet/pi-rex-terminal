import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as pause, setImmediate as tick } from "node:timers/promises";
import { type EditorTheme, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
// Pi exposes this nominal type publicly but its constructor only in the pinned SDK files.
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { type OpenedTerminal, RexInputEditor, type RexTerminal } from "../src/index.ts";

class TestShell implements RexTerminal {
	readonly blockId: string;
	readonly closed = Promise.withResolvers<void>();
	content: string;
	closeCount = 0;
	private count = 0;

	constructor(id: string) {
		this.blockId = id;
		this.content = `fresh ${id}`;
	}
	async screen() {
		return this.content;
	}
	async cursor() {
		return { row: 1, column: 1, trailingBlankLines: 0 };
	}
	async write(data: string) {
		if (data.includes("\r")) {
			this.count++;
			this.content = `command output from ${this.blockId}`;
		}
	}
	async resize() {}
	async exited() {
		return false;
	}
	async exists() {
		return this.closeCount === 0;
	}
	async completion() {
		return this.count;
	}
	async completedScreen() {
		return this.content;
	}
	async close() {
		this.closeCount++;
		this.closed.resolve();
	}
	opened(): OpenedTerminal {
		return {
			terminal: this,
			initial: this.content,
			initialCursor: { row: 1, column: 1, trailingBlankLines: 0 },
			baseline: this.content,
			completion: 0,
		};
	}
}

function fixture(
	open: ConstructorParameters<typeof RexInputEditor>[3],
	capture: ConstructorParameters<typeof RexInputEditor>[4] = async () => {},
) {
	const terminal: Terminal = {
		columns: 100,
		rows: 30,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		async drainInput() {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	};
	const plain = (text: string) => text;
	const theme: EditorTheme = {
		borderColor: plain,
		selectList: {
			selectedPrefix: plain,
			selectedText: plain,
			description: plain,
			scrollInfo: plain,
			noMatch: plain,
		},
	};
	const errors: string[] = [];
	const editor = new RexInputEditor(
		new TuiMainScreen(terminal),
		theme,
		new KeybindingsManager(),
		open,
		capture,
		(error) => errors.push(error),
	);
	return { editor, errors };
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 1500;
	while (!check()) {
		assert.ok(Date.now() < deadline, "editor did not reach expected state");
		await pause(1);
	}
}

function isReady(editor: RexInputEditor): boolean {
	return editor.render(80).some((line) => line.startsWith("╭─ Ctrl+] return "));
}

test("first visit opens at the dimensions already rendered by Pi", { timeout: 3000 }, async (t) => {
	const dimensions: number[][] = [];
	const shell = new TestShell("sized");
	let resizes = 0;
	shell.resize = async () => {
		resizes++;
	};
	const { editor } = fixture(async (columns, rows) => {
		dimensions.push([columns, rows]);
		return shell.opened();
	});
	t.after(() => editor.disposeShell());
	editor.render(100);
	editor.handleInput("$");
	await until(() => editor.render(100).some((line) => line.startsWith("╭─ Ctrl+] return ")));
	assert.deepEqual(dimensions, [[98, 20]]);
	assert.equal(resizes, 0);
});

test(
	"a slow screen read does not delay input and gets a follow-up for its stale result",
	{ timeout: 3000 },
	async (t) => {
		const shell = new TestShell("typing");
		const reading = Promise.withResolvers<void>();
		const firstScreen = Promise.withResolvers<string>();
		const writes: string[] = [];
		let reads = 0;
		shell.write = async (data) => {
			writes.push(data);
			shell.content = writes.join("");
		};
		shell.screen = () => {
			reads++;
			if (reads === 1) {
				reading.resolve();
				return firstScreen.promise;
			}
			return Promise.resolve(shell.content);
		};
		const { editor } = fixture(async () => shell.opened());
		t.after(async () => {
			firstScreen.resolve("a");
			await editor.disposeShell();
		});
		editor.render(80);
		editor.handleInput("$");
		await until(() => isReady(editor));
		editor.handleInput("a");
		await reading.promise;
		editor.handleInput("b");
		await pause(40);
		assert.deepEqual(writes, ["a", "b"], "screen reads must not hold up input writes");
		firstScreen.resolve("a");
		await tick();
		assert.equal(reads, 2, "a stale read must be refreshed without waiting for the idle poll");
		assert.ok(editor.render(80).some((line) => line.includes("ab")));
	},
);

test(
	"input arriving during a write is coalesced and drained before manual capture and close",
	{ timeout: 3000 },
	async (t) => {
		const shell = new TestShell("backpressure");
		const started = Promise.withResolvers<void>();
		const firstWrite = Promise.withResolvers<void>();
		const writes: string[] = [];
		const captured: string[] = [];
		shell.write = async (data) => {
			assert.equal(shell.closeCount, 0, "no input may be written after close");
			writes.push(data);
			if (writes.length === 1) {
				started.resolve();
				await firstWrite.promise;
			}
			shell.content = writes.join("");
		};
		const { editor } = fixture(
			async () => shell.opened(),
			async () => {
				assert.equal(shell.closeCount, 0);
				captured.push(shell.content);
			},
		);
		t.after(async () => {
			firstWrite.resolve();
			await editor.disposeShell();
		});
		editor.render(80);
		editor.handleInput("$");
		await until(() => isReady(editor));
		editor.handleInput("a");
		await started.promise;
		editor.handleInput("b");
		await pause(20);
		editor.handleInput("c");
		await pause(20);
		editor.handleInput("d");
		editor.handleInput("\x1d");
		firstWrite.resolve();
		await shell.closed.promise;
		assert.deepEqual(writes, ["a", "bcd"]);
		assert.deepEqual(captured, ["abcd"]);
		assert.equal(shell.closeCount, 1);
	},
);

test("a write failure during manual return is reported and still closes once", { timeout: 3000 }, async () => {
	const shell = new TestShell("failed-write");
	const started = Promise.withResolvers<void>();
	const write = Promise.withResolvers<void>();
	let captures = 0;
	shell.write = () => {
		started.resolve();
		return write.promise;
	};
	const { editor, errors } = fixture(
		async () => shell.opened(),
		async () => {
			captures++;
		},
	);
	editor.render(80);
	editor.handleInput("$");
	await until(() => isReady(editor));
	editor.handleInput("a");
	await started.promise;
	editor.handleInput("\x1d");
	write.reject(new Error("input write failed"));
	await shell.closed.promise;
	await tick();
	assert.deepEqual(errors, ["input write failed"]);
	assert.equal(captures, 0, "failed input must not be reported as a successful capture");
	assert.equal(shell.closeCount, 1);
	await editor.disposeShell();
});

test("a write failure while typing reports once and closes its shell", { timeout: 3000 }, async (t) => {
	const shell = new TestShell("failed-typing");
	shell.write = async () => {
		throw new Error("input failed while typing");
	};
	const { editor, errors } = fixture(async () => shell.opened());
	t.after(() => editor.disposeShell());
	editor.render(80);
	editor.handleInput("$");
	await until(() => isReady(editor));
	editor.handleInput("a");
	await shell.closed.promise;
	await tick();
	assert.deepEqual(errors, ["input failed while typing"]);
	assert.equal(shell.closeCount, 1);
});

test("actual editor captures and closes each command before opening the next visit", { timeout: 3000 }, async (t) => {
	const shells: TestShell[] = [];
	const captured: string[] = [];
	const { editor } = fixture(
		async () => {
			const shell = new TestShell(`visit-${shells.length + 1}`);
			shells.push(shell);
			return shell.opened();
		},
		async (terminal, _baseline, output) => {
			assert.equal(await terminal.exists(), true, "capture must precede close");
			captured.push(output);
		},
	);
	t.after(() => editor.disposeShell());
	editor.handleInput("$");
	await until(() => isReady(editor));
	editor.handleInput("printf test\r");
	await until(() => shells[0].closeCount === 1);
	await tick();
	assert.deepEqual(captured, ["command output from visit-1"]);
	editor.handleInput("$");
	await until(() => isReady(editor));
	assert.equal(shells.length, 2);
	assert.ok(editor.render(80).some((line) => line.includes("fresh visit-2")));
	assert.ok(editor.render(80).every((line) => !line.includes("command output from visit-1")));
	editor.handleInput("\x1d");
	await shells[1].closed.promise;
	assert.equal(shells[0].closeCount, 1);
});

test(
	"actual editor keeps a cancelled opening closing until its late terminal is released",
	{ timeout: 3000 },
	async (t) => {
		const pending = Promise.withResolvers<OpenedTerminal>();
		const shell = new TestShell("late");
		let captures = 0;
		const { editor } = fixture(
			() => pending.promise,
			async () => {
				captures++;
			},
		);
		t.after(() => editor.disposeShell());
		editor.handleInput("$");
		editor.handleInput("\x1d");
		assert.ok(editor.render(80).some((line) => line.includes("Closing…")));
		pending.resolve(shell.opened());
		await shell.closed.promise;
		await tick();
		assert.equal(captures, 0);
		assert.equal(shell.closeCount, 1);
		assert.ok(editor.render(80).every((line) => !line.startsWith("╭")));
	},
);

test("actual editor disposal awaits an in-flight capture and closes only once", { timeout: 3000 }, async () => {
	const started = Promise.withResolvers<void>();
	const capture = Promise.withResolvers<void>();
	const shell = new TestShell("capture");
	let captures = 0;
	const { editor } = fixture(
		async () => shell.opened(),
		async () => {
			captures++;
			started.resolve();
			await capture.promise;
		},
	);
	editor.handleInput("$");
	await until(() => isReady(editor));
	editor.handleInput("\x1d");
	await started.promise;
	const disposed = editor.disposeShell();
	await tick();
	assert.equal(shell.closeCount, 0);
	capture.resolve();
	await disposed;
	assert.equal(captures, 1);
	assert.equal(shell.closeCount, 1);
});

test("shutdown during a failed post-ready cleanup has no unhandled activate rejection", { timeout: 3000 }, async () => {
	const closeStarted = Promise.withResolvers<void>();
	const close = Promise.withResolvers<void>();
	const shell = new TestShell("failed-resize");
	const resizeError = new Error("post-ready resize failed");
	const closeError = new Error("close failed during shutdown");
	shell.resize = async () => {
		throw resizeError;
	};
	shell.close = () => {
		closeStarted.resolve();
		return close.promise;
	};
	const { editor, errors } = fixture(async () => shell.opened());
	editor.handleInput("$");
	// Render after activation captured its initial dimensions to require post-ready resize.
	editor.render(100);
	await closeStarted.promise;
	const rejected = assert.rejects(editor.disposeShell(), (error) => error === closeError);
	close.reject(closeError);
	await rejected;
	await tick();
	assert.deepEqual(errors, [resizeError.message]);
});
