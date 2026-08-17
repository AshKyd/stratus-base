<svelte:head>
	<title>Stratus Base - Backend Testers</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<main class="container">
	<header class="header">
		<h1>Stratus Base</h1>
		<p class="subtitle">Client-side flat file storage library with end-to-end encryption</p>
	</header>

	<section class="dashboard">
		<h2>Interactive Backend Testers</h2>
		<p class="section-desc">Select a storage backend provider below to manually configure and test its CRUD operations in the browser:</p>
		
		<div class="card-grid">
			<a href="/test/dropbox" class="backend-card">
				<div class="card-header">
					<span class="icon">📦</span>
					<h3>Dropbox Storage</h3>
				</div>
				<p class="card-desc">Test authorization code flow with PKCE, token refresh, and atomic write-then-rename files operations.</p>
				<span class="action-link">Open Tester →</span>
			</a>

			<a href="/test/google-drive" class="backend-card">
				<div class="card-header">
					<span class="icon">🤖</span>
					<h3>Google Drive</h3>
				</div>
				<p class="card-desc">Test authorization code flow with PKCE, token refresh, and atomic write-then-rename files operations on Google Drive.</p>
				<span class="action-link">Open Tester →</span>
			</a>

			<div class="backend-card coming-soon">
				<div class="card-header">
					<span class="icon">☁️</span>
					<h3>Amazon S3 / R2</h3>
				</div>
				<p class="card-desc">Future support for Amazon S3 or Cloudflare R2 backends using key-based configurations.</p>
				<span class="badge">Coming Soon</span>
			</div>
		</div>
	</section>
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
		max-width: 900px;
		margin: 0 auto;
		padding: 80px 20px;
	}

	.header {
		text-align: center;
		margin-bottom: 60px;
	}

	h1 {
		font-size: 3rem;
		font-weight: 700;
		background: linear-gradient(135deg, #60a5fa, #c084fc);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		margin-bottom: 12px;
		letter-spacing: -0.02em;
	}

	.subtitle {
		color: #94a3b8;
		font-size: 1.25rem;
		font-weight: 300;
		max-width: 600px;
		margin: 0 auto;
	}

	.dashboard {
		background: rgba(30, 41, 59, 0.3);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-radius: 24px;
		padding: 40px;
		box-shadow: 0 4px 30px rgba(0, 0, 0, 0.15);
	}

	h2 {
		font-size: 1.5rem;
		margin-top: 0;
		margin-bottom: 10px;
		color: #f1f5f9;
		font-weight: 600;
	}

	.section-desc {
		color: #94a3b8;
		margin-top: 0;
		margin-bottom: 30px;
		font-size: 1rem;
	}

	.card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 20px;
	}

	.backend-card {
		background: rgba(15, 23, 42, 0.4);
		border: 1px solid rgba(255, 255, 255, 0.05);
		border-radius: 16px;
		padding: 24px;
		text-decoration: none;
		color: inherit;
		display: flex;
		flex-direction: column;
		transition: transform 0.2s, border-color 0.2s, background 0.2s;
	}

	.backend-card:not(.coming-soon):hover {
		transform: translateY(-4px);
		border-color: #3b82f6;
		background: rgba(15, 23, 42, 0.6);
	}

	.card-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 14px;
	}

	.icon {
		font-size: 1.5rem;
	}

	h3 {
		font-size: 1.15rem;
		margin: 0;
		color: #f1f5f9;
		font-weight: 600;
	}

	.card-desc {
		font-size: 0.9rem;
		color: #94a3b8;
		line-height: 1.5;
		margin-top: 0;
		margin-bottom: 24px;
		flex-grow: 1;
	}

	.action-link {
		font-size: 0.9rem;
		color: #3b82f6;
		font-weight: 500;
	}

	.coming-soon {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.badge {
		font-size: 0.75rem;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.1);
		color: #94a3b8;
		padding: 4px 10px;
		border-radius: 20px;
		align-self: flex-start;
		font-weight: 500;
	}
</style>
