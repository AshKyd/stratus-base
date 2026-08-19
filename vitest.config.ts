import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
	plugins: [sveltekit()],
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
});
