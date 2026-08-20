import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dev } from '$app/environment';

const BACKEND_PREFIXES: Record<string, string> = {
	'google-drive': 'GOOGLE',
	'dropbox': 'DROPBOX',
	'github': 'GITHUB',
	's3': 'S3'
};

/**
 * Handles incoming POST requests to save credentials to the local .env file.
 * Only allows requests when running in development mode.
 */
export const POST: RequestHandler = async ({ request }) => {
	// Only allow persisting credentials in local development mode
	if (!dev) {
		throw error(403, 'Forbidden in production');
	}

	const { backendId, credentials = {}, config = {} } = await request.json();

	const prefix = BACKEND_PREFIXES[backendId];
	if (!prefix) {
		throw error(400, `Unsupported backend ID: ${backendId}`);
	}

	// Prepare env variables to update
	const updates: Record<string, string> = {};

	// Map client config values
	if (config.clientId) {
		updates[`${prefix}_CLIENT_ID`] = config.clientId;
	}

	// Map credentials
	if (credentials.accessToken) {
		updates[`${prefix}_ACCESS_TOKEN`] = credentials.accessToken;
	}
	if (credentials.refreshToken) {
		updates[`${prefix}_REFRESH_TOKEN`] = credentials.refreshToken;
	}
	if (credentials.expiresAt) {
		updates[`${prefix}_EXPIRES_AT`] = String(credentials.expiresAt);
	}

	if (Object.keys(updates).length === 0) {
		return json({ success: true, message: 'No credentials to update' });
	}

	const envPath = path.resolve(process.cwd(), '.env');

	try {
		let envContent = '';
		try {
			envContent = await fs.readFile(envPath, 'utf-8');
		} catch {
			// File does not exist yet, we will create it
		}

		let lines = envContent.split('\n');

		// Update or append each environment variable
		Object.entries(updates).forEach(([key, value]) => {
			const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
			if (index !== -1) {
				lines[index] = `${key}="${value}"`;
			} else {
				lines.push(`${key}="${value}"`);
			}
		});

		// Write back the updated file content
		await fs.writeFile(envPath, lines.join('\n').trim() + '\n', 'utf-8');

		return json({ success: true, updated: Object.keys(updates) });
	} catch (err: any) {
		throw error(500, `Failed to write credentials to .env: ${err.message || err}`);
	}
};
