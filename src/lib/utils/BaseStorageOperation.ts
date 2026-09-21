import type { StorageOperation, StorageOperationEvents } from '../types.ts';

/** Minimum gap between progress events for one operation. */
export const PROGRESS_INTERVAL_MS = 100;

export class BaseStorageOperation<T> implements StorageOperation<T> {
	readonly finished: Promise<T>;
	private abortController = new AbortController();
	private listeners: { [K in keyof StorageOperationEvents]?: StorageOperationEvents[K][] } = {};
	/** Time of the last progress event passed on; 0 before the first. */
	private lastProgressAt = 0;

	/**
	 * Streamed downloads and XHR uploads report progress many times per chunk. Each event becomes
	 * a worker message and a UI update, so they are thinned to one per PROGRESS_INTERVAL_MS. The
	 * first event and the completing one (`loaded >= total`) always go through, so the bar starts
	 * moving straight away and always reaches the end.
	 */
	private reportProgress(loaded: number, total: number): void {
		const now = Date.now();
		const isFirst = this.lastProgressAt === 0;
		const isComplete = total > 0 && loaded >= total;
		if (!isFirst && !isComplete && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
		this.lastProgressAt = now;
		this.emit('progress', { loaded, total });
	}

	constructor(
		executor: (
			signal: AbortSignal,
			onProgress: (loaded: number, total: number) => void
		) => Promise<T>,
		isTransientError: (error: any) => boolean = (err) => {
			if (err && typeof err.status === 'number') {
				return err.status === 429 || (err.status >= 500 && err.status < 600);
			}
			return true;
		}
	) {
		this.finished = (async () => {
			let attempt = 1;
			while (true) {
				try {
					if (this.abortController.signal.aborted) {
						throw new DOMException('Operation aborted', 'AbortError');
					}
					return await executor(this.abortController.signal, (loaded, total) =>
						this.reportProgress(loaded, total)
					);
				} catch (error: any) {
					if (error.name === 'AbortError') {
						throw error;
					}
					const isTransient = isTransientError(error);
					if (isTransient && attempt < 3) {
						const delayMs = attempt * 1000;
						this.emit('retry', error, attempt, delayMs);
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(resolve, delayMs);
							this.abortController.signal.addEventListener('abort', () => {
								clearTimeout(timer);
								reject(new DOMException('Operation aborted', 'AbortError'));
							});
						});
						attempt++;
						continue;
					}
					throw error;
				}
			}
		})();
	}

	cancel(): void {
		this.abortController.abort();
	}

	on<E extends keyof StorageOperationEvents>(event: E, callback: StorageOperationEvents[E]): this {
		if (!this.listeners[event]) {
			this.listeners[event] = [];
		}
		this.listeners[event]!.push(callback);
		return this;
	}

	private emit<E extends keyof StorageOperationEvents>(
		event: E,
		...args: Parameters<StorageOperationEvents[E]>
	): void {
		const list = this.listeners[event];
		if (list) {
			list.forEach((cb) => (cb as any)(...args));
		}
	}
}
