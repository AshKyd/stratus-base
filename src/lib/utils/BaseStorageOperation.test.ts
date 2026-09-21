import test from 'node:test';
import assert from 'node:assert';
import { BaseStorageOperation } from './BaseStorageOperation.ts';

/**
 * The executor starts inside the constructor, before the test can attach a listener. Real
 * backends always await a request first; this stands in for that.
 */
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('BaseStorageOperation thins progress events but keeps the first and the last', async () => {
	const events: number[] = [];
	const op = new BaseStorageOperation(async (_signal, onProgress) => {
		await nextTick();
		// Fired back to back, well inside one throttle interval.
		[10, 20, 30, 40, 100].forEach((loaded) => onProgress(loaded, 100));
		return 'done';
	});
	op.on('progress', ({ loaded }) => events.push(loaded));

	assert.strictEqual(await op.finished, 'done');
	assert.deepStrictEqual(events, [10, 100]);
});

test('BaseStorageOperation passes progress through again once the interval has passed', async () => {
	const events: number[] = [];
	const op = new BaseStorageOperation(async (_signal, onProgress) => {
		await nextTick();
		onProgress(10, 100);
		await new Promise((resolve) => setTimeout(resolve, 120));
		onProgress(50, 100);
		return 'done';
	});
	op.on('progress', ({ loaded }) => events.push(loaded));

	await op.finished;
	assert.deepStrictEqual(events, [10, 50]);
});
