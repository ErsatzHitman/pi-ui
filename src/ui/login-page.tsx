import { syncHtml } from "./sync-html.ts";

export interface LoginPageOptions {
	/** Where to send the browser after a successful login (a sanitized, local path). */
	next: string;
	/** Path the form posts to, e.g. endpoints.sessionLogin. */
	loginPath: string;
	/** Shown above the field when a previous attempt failed. */
	error?: string;
}

/**
 * The pre-auth login page: served by request-auth.ts to an unauthenticated browser
 * navigation. Deliberately has no Datastar and no session-derived state — it must render
 * before any of that exists. It links the app's real, unversioned `/app.css` and
 * `/theme.js` (see the public-asset allowlist in request-auth.ts) so it already looks
 * like the rest of pi-ui, in both themes, rather than a bespoke unstyled form.
 *
 * It also links the PWA manifest and icons (round RM2 "pwa"), also public in that same
 * allowlist: Chrome's install prompt and "Add to Home Screen" can trigger from this page
 * (before the person has ever seen the authenticated app), and the launch splash screen
 * a standalone launch shows comes from these same tags either way.
 */
export function renderLoginPage({ next, loginPath, error }: LoginPageOptions): string {
	return syncHtml(
		"<!doctype html>" +
		(
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta
						name="viewport"
						content="width=device-width, initial-scale=1, viewport-fit=cover"
					/>
					<meta name="color-scheme" content="light dark" />
					<meta name="theme-color" content="" />
					<title>Sign in — pi-ui</title>
					<link rel="manifest" href="/manifest.webmanifest" />
					<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
					<link rel="apple-touch-icon" href="/icon-180.png" />
					<link rel="stylesheet" href="/app.css" />
					<script src="/theme.js"></script>
					<style>{loginPageStyle}</style>
				</head>
				<body class="login-page-body">
					<main class="login-page">
						<form
							class="login-card raised-surface"
							method="post"
							action={loginPath}
							autocomplete="off"
						>
							<header class="login-header">
								<img
									class="login-mark"
									src="/favicon.svg"
									alt=""
									width="28"
									height="28"
								/>
								<h1>Sign in to pi-ui</h1>
								<p>This server requires its access token to continue.</p>
							</header>
							{error && (
								<p class="login-error" role="alert" safe>
									{error}
								</p>
							)}
							<div class="field" data-invalid={error ? "true" : undefined}>
								<label for="login-token">Access token</label>
								<input
									id="login-token"
									name="token"
									type="password"
									autocomplete="current-password"
									autofocus
									required
								/>
							</div>
							<input type="hidden" name="next" value={next} />
							<button class="btn" data-size="lg" type="submit">
								Continue
							</button>
						</form>
					</main>
				</body>
			</html>
		),
	);
}

const loginPageStyle = `
	.login-page-body {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100%;
		padding: 1.5rem;
	}

	.login-page {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: center;
	}

	.login-card {
		display: grid;
		width: min(22rem, 100%);
		gap: 1.25rem;
		padding: 1.5rem;
	}

	.login-header {
		display: grid;
		gap: 0.5rem;
		text-align: center;
	}

	.login-mark {
		margin-inline: auto;
	}

	.login-header h1 {
		font-size: var(--text-2xl);
		font-weight: 500;
	}

	.login-header p {
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.login-error {
		border: 1px solid var(--status-danger);
		border-radius: var(--radius-md);
		background: color-mix(in oklch, var(--status-danger) 12%, transparent);
		padding: 0.5rem 0.75rem;
		color: var(--status-danger);
		font-size: var(--text-sm);
	}

	.login-card .btn {
		width: 100%;
	}
`;
