import type { StorageOperation, StorageOperationEvents } from '../types.ts';

export class BaseStorageOperation<T> implements StorageOperation<T> {
	readonly finished: Promise<T>;
	private abortController = new AbortController();
	private listeners: { [K in keyof StorageOperationEvents]?: StorageOperationEvents[K][] } = {};

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
					return await executor(this.abortController.signal, (loaded, total) => {
						this.emit('progress', { loaded, total });
					});
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
