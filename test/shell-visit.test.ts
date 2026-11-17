import assert from "node:assert/strict";
import { test } from "node:test";
import { closeIfPresent, initializeVisit, ShellVisit } from "../src/shell-visit.ts";

test(
	"finishing during pending creation releases its eventual resource without adopting it",
	{ timeout: 1000 },
	async () => {
		const opening = Promise.withResolvers<{ id: string }>();
		const closed: string[] = [];
		const visit = new ShellVisit(
			() => opening.promise,
			async (resource) => {
				closed.push(resource.id);
			},
		);
		const ready = visit.ready();
		const ending = visit.finish();
		assert.equal(visit.finish(), ending);
		opening.resolve({ id: "late-allocation" });
		assert.equal(await ready, undefined);
		await ending;
		assert.deepEqual(closed, ["late-allocation"]);
	},
);

test(
	"capture finishes before release, and concurrent disposal cannot double capture or close",
	{ timeout: 1000 },
	async () => {
		const captured = Promise.withResolvers<void>();
		const order: string[] = [];
		const visit = new ShellVisit(
			async () => "shell",
			async () => {
				order.push("close");
			},
		);
		await visit.ready();
		const ending = visit.finish(async () => {
			order.push("capture");
			await captured.promise;
			order.push("saved");
		});
		await Promise.resolve();
		assert.equal(visit.finish(), ending);
		assert.deepEqual(order, ["capture"]);
		captured.resolve();
		await ending;
		assert.deepEqual(order, ["capture", "saved", "close"]);
	},
);

test("failed capture still closes the shell and preserves the failure", { timeout: 1000 }, async () => {
	const captureError = new Error("capture failed");
	let closed = false;
	const visit = new ShellVisit(
		async () => "shell",
		async () => {
			closed = true;
		},
	);
	await visit.ready();
	await assert.rejects(
		visit.finish(async () => {
			throw captureError;
		}),
		(error) => error === captureError,
	);
	assert.equal(closed, true);
});

test("capture and close failures both remain observable", { timeout: 1000 }, async () => {
	const captureError = new Error("capture failed");
	const closeError = new Error("close failed");
	const visit = new ShellVisit(
		async () => "shell",
		async () => {
			throw closeError;
		},
	);
	await visit.ready();
	await assert.rejects(
		visit.finish(async () => {
			throw captureError;
		}),
		(error) => {
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(error.errors, [captureError, closeError]);
			return true;
		},
	);
});

test("disposing an initialized visit without capture releases it", { timeout: 1000 }, async () => {
	const closed: string[] = [];
	const visit = new ShellVisit(
		async () => "shell",
		async (resource) => {
			closed.push(resource);
		},
	);
	await visit.ready();
	await visit.finish();
	assert.equal(await visit.ready(), undefined);
	assert.deepEqual(closed, ["shell"]);
});

test("failure after allocation releases the resource before rejecting", { timeout: 1000 }, async () => {
	const events: string[] = [];
	const error = new Error("bad cursor response");
	await assert.rejects(
		initializeVisit(
			async () => {
				events.push("init");
				throw error;
			},
			async () => {
				events.push("close");
			},
			new AbortController().signal,
		),
		(actual) => actual === error,
	);
	assert.deepEqual(events, ["init", "close"]);
});

test("cancellation after allocation skips initialization and releases the resource", { timeout: 1000 }, async () => {
	const allocated = Promise.withResolvers<void>();
	const closed: string[] = [];
	let initialized = false;
	const visit = new ShellVisit(
		async (signal) => {
			await allocated.promise;
			return initializeVisit(
				async () => {
					initialized = true;
					return "shell";
				},
				async () => {
					closed.push("shell");
				},
				signal,
			);
		},
		async () => {
			closed.push("released twice");
		},
	);
	const ready = visit.ready();
	const rejected = assert.rejects(ready, { name: "AbortError" });
	const ending = visit.finish();
	allocated.resolve();
	await ending;
	await rejected;
	assert.equal(initialized, false);
	assert.deepEqual(closed, ["shell"]);
});

test("a failed close is accepted only when the exact resource is absent", { timeout: 1000 }, async () => {
	const error = new Error("close RPC failed");
	await closeIfPresent(
		async () => {
			throw error;
		},
		async () => false,
	);
	await assert.rejects(
		closeIfPresent(
			async () => {
				throw error;
			},
			async () => true,
		),
		(actual) => actual === error,
	);
	await assert.rejects(
		closeIfPresent(
			async () => {
				throw error;
			},
			async () => {
				throw new Error("list failed");
			},
		),
		AggregateError,
	);
});

test("cancelling an in-flight initialization stops later setup and closes once", { timeout: 1000 }, async () => {
	const started = Promise.withResolvers<void>();
	const step = Promise.withResolvers<void>();
	const events: string[] = [];
	const visit = new ShellVisit(
		(signal) =>
			initializeVisit(
				async () => {
					started.resolve();
					await step.promise;
					signal.throwIfAborted();
					events.push("bootstrap");
					return "shell";
				},
				async () => {
					events.push("close");
				},
				signal,
			),
		async () => {
			events.push("released twice");
		},
	);
	const rejected = assert.rejects(visit.ready(), { name: "AbortError" });
	await started.promise;
	const ending = visit.finish();
	step.resolve();
	await ending;
	await rejected;
	assert.deepEqual(events, ["close"]);
});

test("initialization and cleanup failures are both preserved", { timeout: 1000 }, async () => {
	const setupError = new Error("setup failed");
	const closeError = new Error("close failed");
	await assert.rejects(
		initializeVisit(
			async () => {
				throw setupError;
			},
			async () => {
				throw closeError;
			},
			new AbortController().signal,
		),
		(error) => {
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(error.errors, [setupError, closeError]);
			return true;
		},
	);
});
