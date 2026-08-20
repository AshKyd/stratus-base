import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { playwright } from '@vitest/browser-playwright';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');

	return {
		plugins: [sveltekit()],
		define: {
			'process.env.GOOGLE_CLIENT_ID': JSON.stringify(env.GOOGLE_CLIENT_ID || ''),
			'process.env.GOOGLE_ACCESS_TOKEN': JSON.stringify(env.GOOGLE_ACCESS_TOKEN || ''),
			'process.env.GOOGLE_EXPIRES_AT': JSON.stringify(env.GOOGLE_EXPIRES_AT || '')
		},
		test: {
			include: ['src/**/*.browser.spec.ts'],
			browser: {
				enabled: true,
				provider: playwright(),
				instances: [
					{ browser: 'chromium' }
				],
				headless: true
			}
		}
	};
});
