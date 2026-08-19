<script lang="ts">
	import { MemoryStorage } from '$lib/backends/MemoryStorage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';
	import { Padding } from 'svelte-akui';

	const backend = new MemoryStorage();
</script>

<svelte:head>
	<title>Memory Storage Backend Tester</title>
</svelte:head>

<div style="max-width: 1100px; margin: 0 auto; padding: 0 1rem;">
	<Padding size="m" y>
		<header style="text-align: center; margin-bottom: 2rem;">
			<h1 style="font-size: 2.25rem; font-weight: 700; margin-bottom: 0.5rem;">
				Memory Storage Backend Tester
			</h1>
			<p style="color: var(--akui-fg-secondary); font-size: 1.1rem; font-weight: 300; margin: 0;">
				Verify client-side in-memory file CRUD operations without any credentials
			</p>
		</header>

		<StorageTester {backend} title="Memory" configFields={[]} />
	</Padding>
</div>
