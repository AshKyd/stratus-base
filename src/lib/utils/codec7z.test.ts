import test from 'node:test';
import assert from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SevenZipWriter, SevenZipReader } from './codec7z.ts';

test('codec7z roundtrip without encryption', async () => {
	const writer = new SevenZipWriter();

	// Write entries progressively
	await writer.write({
		path: 'note1.txt',
		data: new TextEncoder().encode('Hello world from file 1!')
	});
	await writer.write({
		path: 'folder/note2.txt',
		data: new TextEncoder().encode('Hello from nested file 2!')
	});

	// Finalize to compile archive
	const archiveBytes = await writer.finalize();
	assert.ok(archiveBytes.length > 0);

	// Save to disk for user inspection
	const outputPath = resolve(import.meta.dirname, 'test-codec-output.7z');
	await writeFile(outputPath, archiveBytes);

	// Extract progressively via SevenZipReader
	const reader = new SevenZipReader();
	
	// Simulate progressive streaming ingestion of archive chunks
	const chunkSize = 64;
	for (let i = 0; i < archiveBytes.length; i += chunkSize) {
		const chunk = archiveBytes.slice(i, i + chunkSize);
		await reader.appendChunk(chunk);
	}

	const extractedEntries = new Map<string, string>();
	for await (const entry of reader.extract()) {
		extractedEntries.set(entry.path, new TextDecoder().decode(entry.data));
	}

	assert.strictEqual(extractedEntries.get('note1.txt'), 'Hello world from file 1!');
	assert.strictEqual(extractedEntries.get('folder/note2.txt'), 'Hello from nested file 2!');
});

test('codec7z roundtrip with password encryption and header encryption ("test")', async () => {
	const writer = new SevenZipWriter('test');

	// Write entries progressively
	await writer.write({
		path: 'secret1.txt',
		data: new TextEncoder().encode('Confidential information 1')
	});
	await writer.write({
		path: 'nested/secret2.txt',
		data: new TextEncoder().encode('Confidential information 2')
	});

	// Finalize archive
	const archiveBytes = await writer.finalize();
	assert.ok(archiveBytes.length > 0);

	// Save encrypted archive to disk for user inspection
	const outputPath = resolve(import.meta.dirname, 'test-codec-output-encrypted.7z');
	await writeFile(outputPath, archiveBytes);

	// Extract progressively using SevenZipReader with password
	const reader = new SevenZipReader('test');
	
	// Stream chunks in
	const chunkSize = 32;
	for (let i = 0; i < archiveBytes.length; i += chunkSize) {
		const chunk = archiveBytes.slice(i, i + chunkSize);
		await reader.appendChunk(chunk);
	}

	const extractedEntries = new Map<string, string>();
	for await (const entry of reader.extract()) {
		extractedEntries.set(entry.path, new TextDecoder().decode(entry.data));
	}

	assert.strictEqual(extractedEntries.get('secret1.txt'), 'Confidential information 1');
	assert.strictEqual(extractedEntries.get('nested/secret2.txt'), 'Confidential information 2');
});

test('codec7z finalize reports compression progress in batches and preserves every entry', async () => {
	const writer = new SevenZipWriter();

	// More than one internal batch worth of entries, so this exercises the incremental
	// add-to-existing-archive path, not just a single one-shot compression.
	const fileCount = 30;
	for (let i = 0; i < fileCount; i++) {
		await writer.write({
			path: `note-${i}.txt`,
			data: new TextEncoder().encode(`Contents of note ${i}`)
		});
	}

	const percentages: number[] = [];
	const archiveBytes = await writer.finalize((percent) => percentages.push(percent));
	assert.ok(archiveBytes.length > 0);

	// At least two updates (one per batch) confirms progress is reported incrementally rather
	// than only once at the very end.
	assert.ok(percentages.length >= 2, 'expected more than one progress update across batches');
	assert.ok(
		percentages.every((percent) => percent >= 0 && percent <= 100),
		'expected all progress updates to be valid percentages'
	);
	for (let i = 1; i < percentages.length; i++) {
		assert.ok(percentages[i] >= percentages[i - 1], 'expected progress to never go backwards');
	}
	assert.strictEqual(percentages.at(-1), 100);

	// Every batch's entries must survive being appended into the previous batch's archive.
	const reader = new SevenZipReader();
	await reader.appendChunk(archiveBytes);
	const extracted = new Map<string, string>();
	for await (const entry of reader.extract()) {
		extracted.set(entry.path, new TextDecoder().decode(entry.data));
	}
	for (let i = 0; i < fileCount; i++) {
		assert.strictEqual(extracted.get(`note-${i}.txt`), `Contents of note ${i}`);
	}
});
