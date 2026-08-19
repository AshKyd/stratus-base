<script lang="ts">
	import { MemoryStorage } from '$lib/backends/MemoryStorage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';

	const backend = new MemoryStorage();
</script>

<svelte:head>
	<title>Memory Storage Backend Tester</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<main class="container">
	<header class="header">
		<h1>Memory Storage Backend Tester</h1>
		<p class="subtitle">Verify client-side in-memory file CRUD operations without any credentials</p>
	</header>

	<StorageTester {backend} title="Memory" configFields={[]} />
</main>

<style>
	:global(body) {
		margin: 0;
		background: #0f1115;
		color: #e2e8f0;
		font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		-webkit-font-smoothing: antialiased;
	}

	.container {
		max-width: 1100px;
		margin: 0 auto;
		padding: 40px 20px;
	}

	.header {
		text-align: center;
		margin-bottom: 40px;
	}

	h1 {
		font-size: 2.5rem;
		font-weight: 700;
		background: linear-gradient(135deg, #10b981, #059669);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		margin-bottom: 10px;
	}

	.subtitle {
		color: #94a3b8;
		font-size: 1.1rem;
		font-weight: 300;
	}
</style>
