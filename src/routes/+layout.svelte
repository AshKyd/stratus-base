<script lang="ts">
	import { UIRoot, Sidebar, ControlGroup, ControlItemText, Button, Icon, Padding, Small } from 'svelte-akui';
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	let innerWidth = $state(0);
	let isMobile = $derived(innerWidth < 768);
	let isSidebarOpen = $state(true);

	// Auto-collapse sidebar on mobile screen sizing
	$effect(() => {
		if (isMobile) {
			isSidebarOpen = false;
		} else {
			isSidebarOpen = true;
		}
	});

	function navigateTo(path: string) {
		goto(resolve(path as any) as any);
		if (isMobile) {
			isSidebarOpen = false;
		}
	}
</script>

<svelte:window bind:innerWidth />

<UIRoot>
	<div style="display: flex; min-height: 100vh;">
		<Sidebar
			mode={isMobile ? 'modal' : 'dismissible'}
			bind:isOpen={isSidebarOpen}
			showCloseButton={false}
		>
			{#snippet content()}
				<Padding size="s">
					<!-- Custom brand header to bypass Sidebar header name-shadowing bug -->
					<div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem; margin-bottom: 0.5rem;">
						<Icon name="cpu" size="20" style="color: var(--akui-bg-accent);" />
						<span style="font-weight: 700; font-size: 1.1rem; color: var(--akui-fg);">Stratus Base</span>
					</div>

					<ControlGroup border={false}>
						<ControlItemText label="Dashboard" icon="house" onclick={() => navigateTo('/')} />
						<ControlItemText label="Memory Storage" icon="cpu" onclick={() => navigateTo('/test/memory')} />
						<ControlItemText label="Dropbox" icon="dropbox" onclick={() => navigateTo('/test/dropbox')} />
						<ControlItemText label="Google Drive" icon="google" onclick={() => navigateTo('/test/google-drive')} />
						<ControlItemText label="GitHub" icon="github" onclick={() => navigateTo('/test/github')} />
						<ControlItemText label="Amazon S3" icon="cloud" onclick={() => navigateTo('/test/s3')} />
					</ControlGroup>
				</Padding>
			{/snippet}

			{#snippet footer()}
				<Padding size="m">
					<Small>v0.0.1</Small>
				</Padding>
			{/snippet}
		</Sidebar>

		<div style="flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 100vh;">
			{#if isMobile}
				<header style="display: flex; align-items: center; padding: 0.75rem 1rem; border-bottom: 1px solid var(--akui-border-input); gap: 0.75rem; background: var(--akui-bg);">
					<Button variant="ghost" size="small" onclick={() => (isSidebarOpen = !isSidebarOpen)}>
						<Icon name="list" size="20" />
					</Button>
					<span style="font-weight: 600; font-size: 1.1rem;">Stratus Base</span>
				</header>
			{/if}

			<main style="flex: 1; overflow-y: auto;">
				{@render children()}
			</main>
		</div>
	</div>
</UIRoot>

<style>
	:global(html), :global(body) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
		color-scheme: light dark;
	}
</style>
