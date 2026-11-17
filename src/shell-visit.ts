// Own one shell visit, including initialization, cancellation and capture-before-close.

/** Close a resource unless a failed close can be verified as already gone. */
export async function closeIfPresent(close: () => Promise<void>, exists: () => Promise<boolean>): Promise<void> {
	try {
		await close();
	} catch (closeError) {
		let present: boolean;
		try {
			present = await exists();
		} catch (verificationError) {
			throw new AggregateError([closeError, verificationError], "Closing the shell and checking its removal failed");
		}
		if (present) throw closeError;
	}
}

/** Release an allocated shell if initialization fails or is cancelled. */
export async function initializeVisit<T>(
	initialize: () => Promise<T>,
	close: () => Promise<void>,
	signal: AbortSignal,
): Promise<T> {
	try {
		signal.throwIfAborted();
		const result = await initialize();
		signal.throwIfAborted();
		return result;
	} catch (initializationError) {
		try {
			await close();
		} catch (closeError) {
			throw new AggregateError([initializationError, closeError], "Shell initialization and cleanup failed");
		}
		throw initializationError;
	}
}

/** Give one activation exclusive ownership of its eventual shell. */
export class ShellVisit<T> {
	private readonly controller = new AbortController();
	private readonly opening: Promise<T>;
	private readonly release: (resource: T) => Promise<void>;
	private ending: Promise<void> | undefined;
	reading = false;
	refreshAgain = false;

	constructor(open: (signal: AbortSignal) => Promise<T>, release: (resource: T) => Promise<void>) {
		this.release = release;
		this.opening = Promise.resolve().then(() => open(this.controller.signal));
	}

	async ready(): Promise<T | undefined> {
		const resource = await this.opening;
		return this.ending ? undefined : resource;
	}

	finish(capture?: (resource: T) => Promise<void>): Promise<void> {
		if (this.ending) return this.ending;
		this.controller.abort();
		this.ending = this.finishResource(capture);
		return this.ending;
	}

	private async finishResource(capture: ((resource: T) => Promise<void>) | undefined): Promise<void> {
		let resource: T;
		try {
			resource = await this.opening;
		} catch (error) {
			if (error === this.controller.signal.reason) return;
			throw error;
		}
		const errors: unknown[] = [];
		try {
			await capture?.(resource);
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.release(resource);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Shell capture and cleanup failed");
	}
}
