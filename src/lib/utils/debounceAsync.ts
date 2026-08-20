/**
 * Wraps an async function such that it never runs concurrently.
 * If called while a run is already active, it queues a single execution to run after the active run finishes.
 * If multiple calls are made during an active run, they are coalesced/debounced and will share the result
 * of the same single queued run.
 */
export function debounceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
	let activePromise: Promise<T> | null = null;
	let queuedPromise: Promise<T> | null = null;

	const execute = async (): Promise<T> => {
		if (activePromise) {
			if (!queuedPromise) {
				queuedPromise = (async () => {
					try {
						await activePromise;
					} catch {
						// Ignore failure of active run for the queued run
					} finally {
						queuedPromise = null;
					}
					return execute();
				})();
			}
			return queuedPromise;
		}

		activePromise = fn();
		try {
			return await activePromise;
		} finally {
			activePromise = null;
		}
	};

	return execute;
}
