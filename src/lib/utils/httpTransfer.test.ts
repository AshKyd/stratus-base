import test from 'node:test';
import assert from 'node:assert';
import { readBodyWithProgress, uploadWithProgress } from './httpTransfer.ts';

/** A response whose body arrives in the given chunks. */
function chunkedResponse(chunks: number[][], headers: Record<string, string> = {}): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			chunks.forEach((chunk) => controller.enqueue(new Uint8Array(chunk)));
			controller.close();
		}
	});
	return new Response(stream, { headers });
}

test('readBodyWithProgress joins chunks and reports each one', async () => {
	const progress: [number, number][] = [];
	const bytes = await readBodyWithProgress(
		chunkedResponse([[1, 2], [3], [4, 5]], { 'content-length': '5' }),
		(loaded, total) => progress.push([loaded, total])
	);

	assert.deepStrictEqual([...bytes], [1, 2, 3, 4, 5]);
	assert.deepStrictEqual(progress, [
		[2, 5],
		[3, 5],
		[5, 5]
	]);
});

test('readBodyWithProgress uses the total hint when content-length is missing', async () => {
	const totals: number[] = [];
	await readBodyWithProgress(chunkedResponse([[1], [2]]), (_loaded, total) => totals.push(total), 2);
	assert.deepStrictEqual(totals, [2, 2]);
});

test('uploadWithProgress falls back to fetch without XMLHttpRequest and reports once', async () => {
	const originalFetch = globalThis.fetch;
	let sentBody: unknown = null;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		sentBody = init.body;
		return new Response('{"ok":true}', { status: 200 });
	}) as typeof fetch;

	try {
		const progress: [number, number][] = [];
		const result = await uploadWithProgress({
			url: 'https://example.test/upload',
			body: new Uint8Array([1, 2, 3]),
			onProgress: (loaded, total) => progress.push([loaded, total])
		});

		assert.strictEqual(result.status, 200);
		assert.deepStrictEqual([...(sentBody as Uint8Array)], [1, 2, 3]);
		assert.deepStrictEqual(progress, [[3, 3]]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('uploadWithProgress rejects with the status and parsed error body', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response('{"error_summary":"path/not_found/"}', { status: 409 })) as typeof fetch;

	try {
		await assert.rejects(
			uploadWithProgress({ url: 'https://example.test/upload', body: new Uint8Array([1]) }),
			(err: any) => err.status === 409 && err.error.error_summary === 'path/not_found/'
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
