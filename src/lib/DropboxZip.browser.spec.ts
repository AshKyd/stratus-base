import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { StratusBase } from './StratusBase.ts';
import { DropboxStorage } from './backends/DropboxStorage.ts';
import { MiddlewareZipChunk } from './middleware/MiddlewareZipChunk/MiddlewareZipChunk.ts';

const TEST_ROOT = 'stratus-dbx-zip-stress-test';
const PASSWORD = 'super-secret-test-password-1234';

const hasAccessToken = typeof process !== 'undefined' && process.env.DROPBOX_ACCESS_TOKEN;

async function logToHost(message: string) {
	console.log(message);
	await fetch('/api/write-debug-log', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ message })
	}).catch(() => {});
}

async function clearHostLog() {
	await fetch('/api/write-debug-log', {
		method: 'DELETE'
	}).catch(() => {});
}

describe.runIf(hasAccessToken)('Dropbox Storage with Zip Middleware E2E Stress Tests', () => {
	let backend: DropboxStorage;
	let stratus: StratusBase;

	async function logRemoteState(actionName: string) {
		await logToHost(`>>> ACTION COMPLETED: ${actionName}`);
		try {
			const remoteFiles = await backend.listDirectory('/');
			const chunks = remoteFiles
				.filter((f) => f.name.startsWith('archive_chunk_') || f.name.startsWith('temp_'))
				.sort((a, b) => a.name.localeCompare(b.name));

			const meta = await stratus.getMetadata();

			await logToHost(`Current Dropbox Remote State:`);
			if (chunks.length === 0) {
				await logToHost(`  (no archives or temp files found in root)`);
			}
			for (const chunk of chunks) {
				const cachedMeta = meta.chunks?.[chunk.path];
				const uncompressedSize = cachedMeta?.uncompressedSize ?? 0;
				const filesList = cachedMeta?.files
					? Object.entries(cachedMeta.files)
							.map(([name, fMeta]) => `${name} (${fMeta.size} bytes)`)
							.join(', ')
					: 'none';
				const tempIndicator = chunk.name.startsWith('temp_') ? ' [TEMP]' : '';
				await logToHost(
					`  - ${chunk.name}${tempIndicator} | Size: ${chunk.size} B | Uncompressed: ${uncompressedSize} B | Files: [${filesList}]`
				);
			}
			await logToHost(``);
		} catch (e: any) {
			await logToHost(`Failed to log remote state: ${e.message || e}`);
		}
	}

	beforeEach(async () => {
		await clearHostLog();
		await logToHost('--- E2E Test Suite Initialisation ---');

		// Clean local OPFS
		const root = await navigator.storage.getDirectory();
		try {
			await root.removeEntry(TEST_ROOT, { recursive: true });
			await logToHost('Cleaned local OPFS TEST_ROOT directory');
		} catch {
			// Ignore if doesn't exist
		}

		// Initialize Dropbox Storage using injected dev env tokens
		backend = new DropboxStorage({
			clientId: process.env.DROPBOX_CLIENT_ID || ''
		});
		backend.setCredentials({
			accessToken: process.env.DROPBOX_ACCESS_TOKEN || '',
			expiresAt: Number(process.env.DROPBOX_EXPIRES_AT || Date.now() + 3600000)
		});

		// Clean up any remaining remote archive chunks, temp files, and sync lock from previous runs
		try {
			const files = await backend.listDirectory('/');
			const cleanupFiles = files.filter(
				(f) =>
					f.name.startsWith('archive_chunk_') ||
					f.name.startsWith('temp_archive_chunk_') ||
					f.name.startsWith('temp_sync_archive_') ||
					f.name === 'sync.lock'
			);
			if (cleanupFiles.length > 0) {
				await logToHost(
					`Cleaning up old remote files: ${cleanupFiles.map((f) => f.name).join(', ')}`
				);
				await Promise.all(cleanupFiles.map((f) => backend.deleteFile(f.path)));
				await logToHost('Old remote files deleted successfully.');
			}
		} catch (e) {
			await logToHost(`Initial remote cleanup failed: ${e}`);
		}

		stratus = new StratusBase({
			backend,
			localRoot: TEST_ROOT,
			middleware: new MiddlewareZipChunk({
				password: PASSWORD,
				chunkSizeLimit: 1024 * 1024 // 1MB chunks to force multi-chunk behaviors
			})
		});
	});

	afterEach(async () => {
		await logToHost('--- E2E Test Suite Teardown ---');
		// Clean up remote storage to leave Dropbox clean after tests
		try {
			const files = await backend.listDirectory('/');
			const cleanupFiles = files.filter(
				(f) =>
					f.name.startsWith('archive_chunk_') ||
					f.name.startsWith('temp_archive_chunk_') ||
					f.name.startsWith('temp_sync_archive_') ||
					f.name === 'sync.lock'
			);
			if (cleanupFiles.length > 0) {
				await logToHost(
					`Teardown: Deleting remaining remote files: ${cleanupFiles.map((f) => f.name).join(', ')}`
				);
				await Promise.all(cleanupFiles.map((f) => backend.deleteFile(f.path)));
			}
		} catch (e) {
			await logToHost(`Final remote cleanup failed: ${e}`);
		}

		// Clean local OPFS
		const root = await navigator.storage.getDirectory();
		try {
			await root.removeEntry(TEST_ROOT, { recursive: true });
			await logToHost('Cleaned local OPFS TEST_ROOT directory');
		} catch {
			// Ignore
		}
	});

	test(
		'Full lifecycle stress test: Create, Read, Update, Delete, List, Sync, Clear Local, Re-sync Recovery',
		async () => {
			const txtEncoder = new TextEncoder();
			const txtDecoder = new TextDecoder();

			await logToHost('--- STARTING Lifecycle Stress Test ---');

			// 1. Create multiple files and directories locally
			await logToHost('1. Writing files locally (/doc1.txt, /sub/doc2.txt, /temp.txt)...');
			const file1Content = txtEncoder.encode('Hello Dropbox from Zip E2E!');
			const file2Content = txtEncoder.encode('Nested subfolder file content.');
			const file3Content = txtEncoder.encode('Third file to be deleted later.');

			await stratus.writeFile('/doc1.txt', file1Content);
			await stratus.writeFile('/sub/doc2.txt', file2Content);
			await stratus.writeFile('/temp.txt', file3Content);

			// 2. Perform Sync to push everything to Dropbox
			await logToHost('2. Synchronising local changes to Dropbox...');
			const syncRes1 = await stratus.sync();
			expect(syncRes1.created).toContain('/doc1.txt');
			expect(syncRes1.created).toContain('/sub/doc2.txt');
			expect(syncRes1.created).toContain('/temp.txt');

			await logRemoteState('First sync (creation of files)');

			// 3. Read files locally and verify contents
			await logToHost('3. Reading and verifying files locally...');
			const read1 = await stratus.readFile('/doc1.txt');
			expect(txtDecoder.decode(read1)).toBe('Hello Dropbox from Zip E2E!');

			const read2 = await stratus.readFile('/sub/doc2.txt');
			expect(txtDecoder.decode(read2)).toBe('Nested subfolder file content.');

			// 4. Update an existing file & write a new one & delete the temporary file
			await logToHost(
				'4. Updating files (/doc1.txt updated, /new-file.txt created, /temp.txt deleted)...'
			);
			const updatedContent = txtEncoder.encode('Updated Hello Dropbox from Zip E2E!');
			await stratus.writeFile('/doc1.txt', updatedContent);

			const newFileContent = txtEncoder.encode('Brand new dynamically added file.');
			await stratus.writeFile('/new-file.txt', newFileContent);

			await stratus.deleteFile('/temp.txt');

			// Perform second Sync to apply updates, creations, and deletions
			await logToHost('Syncing updates and deletions...');
			const syncRes2 = await stratus.sync();
			expect(syncRes2.updated).toContain('/doc1.txt');
			expect(syncRes2.created).toContain('/new-file.txt');
			expect(syncRes2.deleted).toContain('/temp.txt');

			await logRemoteState('Second sync (updates and deletions)');

			// 5. Clear Local OPFS State to simulate starting a new device/session
			await logToHost('5. Simulating new device by clearing local OPFS state...');
			const root = await navigator.storage.getDirectory();
			await root.removeEntry(TEST_ROOT, { recursive: true });

			const freshTempStratus = new StratusBase({
				backend,
				localRoot: TEST_ROOT,
				middleware: new MiddlewareZipChunk({ password: PASSWORD, chunkSizeLimit: 1024 * 1024 })
			});
			const checkStat = await freshTempStratus.stat('/doc1.txt');
			expect(checkStat).toBeNull();

			// 6. Perform a full Sync from Dropbox to pull everything back
			await logToHost('6. Syncing down files to recover state...');
			const recoveryRes = await freshTempStratus.sync();
			expect(recoveryRes.created).toContain('/doc1.txt');
			expect(recoveryRes.created).toContain('/sub/doc2.txt');
			expect(recoveryRes.created).toContain('/new-file.txt');
			expect(recoveryRes.deleted).not.toContain('/temp.txt');

			await logRemoteState('Recovery sync');

			// 7. Verify all remaining files are correctly restored with accurate contents
			await logToHost('7. Verifying recovered file contents...');
			const restored1 = await freshTempStratus.readFile('/doc1.txt');
			expect(txtDecoder.decode(restored1)).toBe('Updated Hello Dropbox from Zip E2E!');

			const restoredSub = await freshTempStratus.readFile('/sub/doc2.txt');
			expect(txtDecoder.decode(restoredSub)).toBe('Nested subfolder file content.');

			const restoredNew = await freshTempStratus.readFile('/new-file.txt');
			expect(txtDecoder.decode(restoredNew)).toBe('Brand new dynamically added file.');

			await logToHost('Lifecycle Stress Test Successful.');
		},
		60000
	);

	test(
		'Multi-chunk rollover and consolidation stress test',
		async () => {
			await logToHost('--- STARTING Multi-Chunk Rollover & Consolidation (Defrag) Test ---');

			const fileSize = Math.floor(1.1 * 1024 * 1024);
			const zeroBuffer = new Uint8Array(fileSize);

			await logToHost(
				'Writing 5 large files (1.1MB each) and syncing sequentially to force 5 separate chunks...'
			);

			await stratus.writeFile('/file1.bin', zeroBuffer);
			await stratus.sync();
			await logRemoteState('Write & sync /file1.bin');

			await stratus.writeFile('/file2.bin', zeroBuffer);
			await stratus.sync();
			await logRemoteState('Write & sync /file2.bin');

			await stratus.writeFile('/file3.bin', zeroBuffer);
			await stratus.sync();
			await logRemoteState('Write & sync /file3.bin');

			await stratus.writeFile('/file4.bin', zeroBuffer);
			await stratus.sync();
			await logRemoteState('Write & sync /file4.bin');

			await stratus.writeFile('/file5.bin', zeroBuffer);
			await stratus.sync();
			await logRemoteState('Write & sync /file5.bin');

			// Verify 5 remote chunks exist
			let remoteFiles = await backend.listDirectory('/');
			let chunkFiles = remoteFiles.filter((f) => f.name.startsWith('archive_chunk_'));
			expect(chunkFiles.length).toBe(5);

			// Edit /file1.bin (originally in chunk 1)
			await logToHost(
				'Editing /file1.bin to force a 6th chunk rollover (size limit exceeded in active chunk)...'
			);
			const updatedFile1 = new Uint8Array(fileSize);
			updatedFile1[0] = 42;
			await stratus.writeFile('/file1.bin', updatedFile1);

			await stratus.sync();
			await logRemoteState('Sync edited /file1.bin (6 chunks expected)');

			remoteFiles = await backend.listDirectory('/');
			chunkFiles = remoteFiles.filter((f) => f.name.startsWith('archive_chunk_'));
			expect(chunkFiles.length).toBe(6);

			// Consolidate/defrag back to 5 chunks
			await logToHost('Running consolidate() to defragment archives back to 5 chunks...');
			await stratus.consolidate();
			await logRemoteState('Consolidation/Defrag completed');

			remoteFiles = await backend.listDirectory('/');
			chunkFiles = remoteFiles.filter((f) => f.name.startsWith('archive_chunk_'));
			expect(chunkFiles.length).toBe(5);

			// Verify local clearance and re-sync recovery
			await logToHost('Clearing local OPFS state and re-syncing to verify defragmented restore...');
			const root = await navigator.storage.getDirectory();
			await root.removeEntry(TEST_ROOT, { recursive: true });

			const freshTempStratus = new StratusBase({
				backend,
				localRoot: TEST_ROOT,
				middleware: new MiddlewareZipChunk({ password: PASSWORD, chunkSizeLimit: 1024 * 1024 })
			});

			await freshTempStratus.sync();
			await logRemoteState('Recovery sync after consolidation');

			// Verify file contents
			const restored1 = await freshTempStratus.readFile('/file1.bin');
			expect(restored1.length).toBe(fileSize);
			expect(restored1[0]).toBe(42);

			const restored5 = await freshTempStratus.readFile('/file5.bin');
			expect(restored5.length).toBe(fileSize);
			expect(restored5[0]).toBe(0);

			await logToHost('Consolidation Stress Test Successful.');
		},
		120000
	);

	test(
		'Multi-chunk split in single sync stress test',
		async () => {
			await logToHost('--- STARTING Multi-Chunk Split in Single Sync Test ---');
			const fileSize = Math.floor(1.1 * 1024 * 1024);
			const zeroBuffer = new Uint8Array(fileSize);

			await logToHost('Creating 5 large files locally (1.1MB each) without syncing...');
			await stratus.writeFile('/batch1.bin', zeroBuffer);
			await stratus.writeFile('/batch2.bin', zeroBuffer);
			await stratus.writeFile('/batch3.bin', zeroBuffer);
			await stratus.writeFile('/batch4.bin', zeroBuffer);
			await stratus.writeFile('/batch5.bin', zeroBuffer);

			await logToHost('Running sync() once for all 5 files to verify dynamic chunk-splitting...');
			await stratus.sync();
			await logRemoteState('Single sync of 5 files batch');

			// Verify 5 remote chunks exist
			const remoteFiles = await backend.listDirectory('/');
			const chunkFiles = remoteFiles.filter((f) => f.name.startsWith('archive_chunk_'));
			expect(chunkFiles.length).toBe(5);

			await logToHost('Single-sync Split Test Successful.');
		},
		120000
	);
});
