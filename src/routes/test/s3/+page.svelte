<script lang="ts">
	import { S3Storage } from '$lib/backends/S3Storage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';

	let backend = $state<S3Storage | null>(null);

	const configFields = [
		{
			key: 'accessKeyId',
			label: 'Access Key ID',
			type: 'text' as const,
			placeholder: 'Enter your AWS Access Key ID'
		},
		{
			key: 'secretAccessKey',
			label: 'Secret Access Key',
			type: 'password' as const,
			placeholder: 'Enter your AWS Secret Access Key'
		},
		{
			key: 'region',
			label: 'Region',
			type: 'text' as const,
			placeholder: 'e.g. us-east-1'
		},
		{
			key: 'bucket',
			label: 'Bucket Name',
			type: 'text' as const,
			placeholder: 'Enter your bucket name'
		},
		{
			key: 'endpoint',
			label: 'Endpoint URL (Optional)',
			type: 'text' as const,
			placeholder: 'e.g. https://<account-id>.r2.cloudflarestorage.com',
			helpText: 'Leave empty for official Amazon AWS S3.'
		},
		{
			key: 'forcePathStyle',
			label: 'Force Path Style (Optional)',
			type: 'text' as const,
			placeholder: 'true or false',
			helpText: 'Set to "true" for local test environments (like MinIO or s3rver), or leave empty.'
		}
	];

	async function handleConfigure(configValues: Record<string, string>) {
		backend = new S3Storage({
			accessKeyId: configValues.accessKeyId.trim(),
			secretAccessKey: configValues.secretAccessKey.trim(),
			region: configValues.region.trim(),
			bucket: configValues.bucket.trim(),
			endpoint: configValues.endpoint?.trim() || undefined,
			forcePathStyle: configValues.forcePathStyle?.trim() === 'true'
		});
	}

	// Initialize backend if saved config is complete in localStorage
	if (typeof window !== 'undefined') {
		const savedAccessKeyId = localStorage.getItem('tester_config_s3_accessKeyId');
		const savedSecretAccessKey = localStorage.getItem('tester_config_s3_secretAccessKey');
		const savedRegion = localStorage.getItem('tester_config_s3_region');
		const savedBucket = localStorage.getItem('tester_config_s3_bucket');
		const savedEndpoint = localStorage.getItem('tester_config_s3_endpoint');
		const savedForcePathStyle = localStorage.getItem('tester_config_s3_forcePathStyle');

		if (savedAccessKeyId && savedSecretAccessKey && savedRegion && savedBucket) {
			backend = new S3Storage({
				accessKeyId: savedAccessKeyId.trim(),
				secretAccessKey: savedSecretAccessKey.trim(),
				region: savedRegion.trim(),
				bucket: savedBucket.trim(),
				endpoint: savedEndpoint?.trim() || undefined,
				forcePathStyle: savedForcePathStyle?.trim() === 'true'
			});
		}
	}
</script>

<svelte:head>
	<title>S3 Backend Tester</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<main class="container">
	<header class="header">
		<h1>S3 Storage Backend Tester</h1>
		<p class="subtitle">Securely verify your client-side S3 authentication and file CRUD operations</p>
	</header>

	{#if backend}
		<StorageTester {backend} title="S3" {configFields} onConfigure={handleConfigure} />
	{:else}
		<section class="card">
			<h2>S3 Configuration</h2>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					const fd = new FormData(e.currentTarget);
					const config = {
						accessKeyId: fd.get('accessKeyId') as string,
						secretAccessKey: fd.get('secretAccessKey') as string,
						region: fd.get('region') as string,
						bucket: fd.get('bucket') as string,
						endpoint: fd.get('endpoint') as string,
						forcePathStyle: fd.get('forcePathStyle') as string
					};
					// Save them so Svelte component can read
					Object.entries(config).forEach(([key, value]) => {
						localStorage.setItem(`tester_config_s3_${key}`, value || '');
					});
					handleConfigure(config);
				}}
				class="vertical-form"
			>
				<div class="form-group">
					<label for="accessKeyId">Access Key ID</label>
					<input type="text" id="accessKeyId" name="accessKeyId" placeholder="Enter AWS Access Key ID" required />
				</div>
				<div class="form-group">
					<label for="secretAccessKey">Secret Access Key</label>
					<input type="password" id="secretAccessKey" name="secretAccessKey" placeholder="Enter AWS Secret Access Key" required />
				</div>
				<div class="form-group">
					<label for="region">Region</label>
					<input type="text" id="region" name="region" placeholder="e.g. us-east-1" required />
				</div>
				<div class="form-group">
					<label for="bucket">Bucket Name</label>
					<input type="text" id="bucket" name="bucket" placeholder="Enter bucket name" required />
				</div>
				<div class="form-group">
					<label for="endpoint">Endpoint URL (Optional)</label>
					<input type="text" id="endpoint" name="endpoint" placeholder="e.g. https://<account-id>.r2.cloudflarestorage.com" />
				</div>
				<div class="form-group">
					<label for="forcePathStyle">Force Path Style (Optional)</label>
					<input type="text" id="forcePathStyle" name="forcePathStyle" placeholder="true or false" />
				</div>
				<button type="submit" class="btn btn-primary">Save and Continue</button>
			</form>
		</section>
	{/if}
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
		background: linear-gradient(135deg, #f59e0b, #d97706);
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

	.card {
		background: rgba(30, 41, 59, 0.4);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 16px;
		padding: 24px;
		box-shadow: 0 4px 30px rgba(0, 0, 0, 0.2);
		max-width: 500px;
		margin: 0 auto;
	}

	h2 {
		font-size: 1.3rem;
		margin-top: 0;
		margin-bottom: 20px;
		color: #f1f5f9;
		font-weight: 600;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 20px;
	}

	label {
		font-size: 0.9rem;
		color: #94a3b8;
		font-weight: 500;
	}

	input[type='text'],
	input[type='password'] {
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		padding: 12px;
		color: #f8fafc;
		font-size: 0.95rem;
		transition: border-color 0.2s;
	}

	input[type='text']:focus,
	input[type='password']:focus {
		outline: none;
		border-color: #f59e0b;
	}

	.btn {
		cursor: pointer;
		font-weight: 500;
		padding: 10px 18px;
		border-radius: 8px;
		font-size: 0.95rem;
		transition: transform 0.1s, filter 0.2s;
		border: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.btn:hover {
		filter: brightness(1.1);
	}

	.btn-primary {
		background: #d97706;
		color: white;
		width: 100%;
	}

	.vertical-form {
		display: flex;
		flex-direction: column;
	}
</style>
