<script lang="ts">
	import { LayoutContentWidth, Padding, Panel } from 'svelte-akui';
</script>

<svelte:head>
	<title>Stratus Base - Dashboard</title>
</svelte:head>

<LayoutContentWidth size="medium">
	<Padding size="l" y>
		<header style="text-align: center; margin-bottom: 3rem;">
			<h1 style="font-size: 2.75rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--akui-fg);">
				Stratus Base
			</h1>
			<p style="color: var(--akui-fg-secondary); font-size: 1.15rem; max-width: 600px; margin: 0 auto;">
				Client-side flat file storage library with end-to-end encryption
			</p>
		</header>

		<Panel colour="regular" tag="section">
			<Padding size="m">
				<h2 style="font-size: 1.35rem; font-weight: 600; margin-bottom: 0.5rem;">Interactive Backend Testers</h2>
				<p style="color: var(--akui-fg-secondary); font-size: 0.95rem; line-height: 1.6;">
					Welcome to the Stratus Base test suite. Select a storage backend provider from the navigation sidebar on the left to configure credentials and test file CRUD operations client-side.
				</p>
			</Padding>
		</Panel>
	</Padding>
</LayoutContentWidth>
