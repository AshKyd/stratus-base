<script lang="ts">
	import { DropboxStorage } from '$lib/backends/DropboxStorage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';
	import { Padding, Panel, Field, TextInput, Button } from 'svelte-akui';

	let backend = $state<DropboxStorage | null>(null);

	const configFields = [
		{
			key: 'clientId',
			label: 'Dropbox App Key (Client ID)',
			type: 'text' as const,
			placeholder: 'Enter your Dropbox app client ID',
			helpText: 'Obtained from the settings page of your app in the Dropbox Developer Console.'
		}
	];

	async function handleConfigure(configValues: Record<string, string>) {
		backend = new DropboxStorage({
			clientId: configValues.clientId.trim()
		});
	}

	// Initialize backend if last app key is saved in localStorage
	if (typeof window !== 'undefined') {
		const savedClientId = localStorage.getItem('tester_config_dropbox_clientId');
		if (savedClientId) {
			backend = new DropboxStorage({
				clientId: savedClientId.trim()
			});
		}
	}
</script>

<svelte:head>
	<title>Dropbox Backend Tester</title>
</svelte:head>

<div style="max-width: 1100px; margin: 0 auto; padding: 0 1rem;">
	<Padding size="m" y>
		<header style="text-align: center; margin-bottom: 2rem;">
			<h1 style="font-size: 2.25rem; font-weight: 700; margin-bottom: 0.5rem;">
				Dropbox Storage Backend Tester
			</h1>
			<p style="color: var(--akui-fg-secondary); font-size: 1.1rem; font-weight: 300; margin: 0;">
				Securely verify your client-side Dropbox authentication and file CRUD operations
			</p>
		</header>

		{#if backend}
			<StorageTester {backend} title="Dropbox" {configFields} onConfigure={handleConfigure} />
		{:else}
			<div style="max-width: 500px; margin: 0 auto;">
				<Panel colour="regular">
					<Padding size="m">
						<h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1.25rem;">Dropbox Configuration</h2>
						<form
							onsubmit={(e) => {
								e.preventDefault();
								const fd = new FormData(e.currentTarget);
								const clientId = fd.get('clientId') as string;
								localStorage.setItem('tester_config_dropbox_clientId', clientId || '');
								handleConfigure({ clientId });
							}}
							style="display: flex; flex-direction: column; gap: 1.25rem;"
						>
							<Field
								label="Dropbox App Key (Client ID)"
								hint="Obtained from the settings page of your app in the Dropbox Developer Console."
								for="clientId"
							>
								<TextInput
									type="text"
									id="clientId"
									name="clientId"
									placeholder="Enter your Dropbox app client ID"
									required
								/>
							</Field>
							<Button type="submit" variant="accent" style="width: 100%">
								Save and Continue
							</Button>
						</form>
					</Padding>
				</Panel>
			</div>
		{/if}
	</Padding>
</div>
