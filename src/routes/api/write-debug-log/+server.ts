import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dev } from '$app/environment';

/**
 * Handles appending log lines to debug.txt in development mode.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!dev) {
		throw error(403, 'Forbidden in production');
	}

	const { message } = await request.json();
	const logPath = path.resolve(process.cwd(), 'debug.txt');

	try {
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`, 'utf-8');
		return json({ success: true });
	} catch (err: any) {
		throw error(500, `Failed to write log: ${err.message}`);
	}
};

/**
 * Clears/initialises debug.txt at the start of a test suite run.
 */
export const DELETE: RequestHandler = async () => {
	if (!dev) {
		throw error(403, 'Forbidden in production');
	}

	const logPath = path.resolve(process.cwd(), 'debug.txt');

	try {
		await fs.writeFile(logPath, `=== Stratus E2E Test Debug Log Started at ${new Date().toISOString()} ===\n\n`, 'utf-8');
		return json({ success: true });
	} catch (err: any) {
		throw error(500, `Failed to clear log: ${err.message}`);
	}
};
