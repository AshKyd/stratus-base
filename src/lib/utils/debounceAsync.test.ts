import test from 'node:test';
import assert from 'node:assert';
import { debounceAsync } from './debounceAsync.ts';

test('debounceAsync utility', async (t) => {
	await t.test('executes sequentially if calls are not concurrent', async () => {
		let callCount = 0;
		const fn = async () => {
			callCount++;
			return callCount;
		};

		const debounced = debounceAsync(fn);

		const res1 = await debounced();
		assert.strictEqual(res1, 1);
		assert.strictEqual(callCount, 1);

		const res2 = await debounced();
		assert.strictEqual(res2, 2);
		assert.strictEqual(callCount, 2);
	});

	await t.test('queues and coalesces concurrent calls', async () => {
		let callCount = 0;
		let resolveActive: ((value: unknown) => void) | null = null;
		
		const fn = async () => {
			callCount++;
			return new Promise((resolve) => {
				resolveActive = resolve;
			});
		};

		const debounced = debounceAsync(fn);

		// Start first call
		const p1 = debounced();
		assert.strictEqual(callCount, 1);
		assert.ok(resolveActive !== null);
		const resolver1 = resolveActive!;

		// Queue subsequent calls
		const p2 = debounced();
		const p3 = debounced();

		// Should not trigger concurrent execution yet
		assert.strictEqual(callCount, 1);

		// Resolve first call
		resolver1('first');
		const res1 = await p1;
		assert.strictEqual(res1, 'first');

		// Wait for next run to start
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Now callCount should be 2, and resolveActive should be updated
		assert.strictEqual(callCount, 2);
		assert.ok(resolveActive !== null);
		const resolver2 = resolveActive!;

		// Resolve second call
		resolver2('second');

		const res2 = await p2;
		const res3 = await p3;

		// Both should resolve to the same result from the second run
		assert.strictEqual(res2, 'second');
		assert.strictEqual(res3, 'second');
		assert.strictEqual(callCount, 2);
	});

	await t.test('continues working after an error occurs', async () => {
		let fail = true;
		const fn = async () => {
			if (fail) {
				fail = false;
				throw new Error('Failure');
			}
			return 'success';
		};

		const debounced = debounceAsync(fn);

		await assert.rejects(async () => {
			await debounced();
		}, /Failure/);

		const res = await debounced();
		assert.strictEqual(res, 'success');
	});
});
