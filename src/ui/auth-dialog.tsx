import { endpoints } from "../server/routes/endpoints.ts";
import type { AppAuthDialog, AppAuthProvider } from "../state/app-store.ts";
import { syncHtml } from "./sync-html.ts";

/**
 * Phase change inside an open dialog: the header and the block after it settle in while the
 * panel surface stays put (animating `#auth-dialog-content` itself blanked the whole panel
 * for a frame). The header id changes per phase, so idiomorph inserts a fresh header and
 * `data-init` runs for it; in-phase status and progress patches morph the same header
 * without re-running it. Skipped while the dialog is closed or still running its own
 * entry/exit transition (the first phase of an open: overlays.css already animates the
 * dialog, so a content entry on top would be a double entry). Datastar evaluates `data-init`
 * twice for a morph-inserted node (once for the node, once for its copied attribute), so a
 * header that is already animating is not entered again: one WebAnimation per target.
 */
function authPhaseEnter(from: "rise" | "fade"): string {
	return `const d = el.closest('dialog'); if (d?.open && !d.getAnimations().length && !el.getAnimations().length) { const m = window.piUi?.motion; m?.enter(el, { from: '${from}' }); m?.enter(el.nextElementSibling, { from: '${from}' }); }`;
}
const AUTH_PHASE_ENTER = authPhaseEnter("rise");
const AUTH_RESULT_ENTER = authPhaseEnter("fade");
/** An error line appearing inside a phase: one fade, however often `data-init` evaluates. */
const AUTH_ERROR_ENTER =
	"el.getAnimations().length || window.piUi?.motion?.enter(el, { from: 'fade' })";
/**
 * A closed dialog keeps its last content while it fades out: the `/auth/close` patch renders
 * an ignore-morph placeholder, and Datastar skips a morph only when both the live node and
 * the patch carry `data-ignore-morph`, so the live node is marked once the dialog closes.
 * The next open's patch has no marker and replaces the stale content before `showModal()`.
 */
const AUTH_DIALOG_TOGGLE =
	"document.getElementById('auth-dialog-content')?.toggleAttribute('data-ignore-morph', evt.newState === 'closed')";

export function renderAuthDialog(dialog: AppAuthDialog | undefined): string {
	return syncHtml(
		<dialog
			id="auth-dialog"
			class="dialog"
			aria-labelledby="auth-dialog-title"
			closedby="any"
			data-on:toggle={AUTH_DIALOG_TOGGLE}
			data-on:close={`@post('${endpoints.authClose}', { payload: {} })`}
			data-signals__ifmissing={JSON.stringify({
				_authSearch: "",
				authProvider: "",
				authType: "",
				authInput: "",
			})}
		>
			{renderAuthDialogContent(dialog)}
		</dialog>,
	);
}

export function renderAuthDialogContent(dialog: AppAuthDialog | undefined): string {
	return syncHtml(
		<div
			id="auth-dialog-content"
			class="dialog-wide"
			data-ignore-morph={dialog ? undefined : true}
		>
			{dialog ? renderDialogContent(dialog) : <div />}
		</div>,
	);
}

function renderDialogContent(dialog: AppAuthDialog): string {
	if (dialog.phase === "providers") {
		return renderProviderPicker(dialog);
	}
	if (dialog.phase === "api-key" || dialog.phase === "oauth") {
		return renderAuthenticationFlow(dialog);
	}
	return renderResult(dialog);
}

function renderProviderPicker(dialog: AppAuthDialog): string {
	const title = dialog.mode === "login" ? "Log in" : "Log out";
	const providerHaystacks = dialog.providers.map(providerSearchHaystack);
	return syncHtml(
		<>
			<header id={`auth-phase-${dialog.phase}`} data-init={AUTH_PHASE_ENTER}>
				<h2 id="auth-dialog-title">{title}</h2>
				<p>
					{dialog.mode === "login"
						? "Choose a provider and authentication method."
						: "Remove credentials stored in ~/.pi/agent/auth.json."}
				</p>
			</header>
			{dialog.providers.length > 0 && (
				<div>
					<label class="sr-only" for="auth-provider-search">
						Search providers
					</label>
					<input
						id="auth-provider-search"
						type="search"
						class="input"
						placeholder="Search providers..."
						autocomplete="off"
						autocorrect="off"
						spellcheck="false"
						aria-controls="auth-provider-list"
						data-bind:_auth-search
						autofocus
					/>
				</div>
			)}
			<div id="auth-provider-list" class="dialog-option-list">
				{dialog.providers.length === 0 ? (
					<p class="dialog-empty" safe>
						{dialog.error ??
							dialog.status ??
							(dialog.mode === "login"
								? "No authentication providers are available."
								: "No stored credentials to remove.")}
					</p>
				) : (
					<>
						{dialog.providers.map((provider) =>
							renderProviderButton(provider, dialog.mode),
						)}
						<p
							class="dialog-empty"
							role="status"
							style="display: none"
							data-show={`!${JSON.stringify(providerHaystacks)}.some((provider) => provider.includes($_authSearch.trim().toLowerCase()))`}
						>
							No providers found.
						</p>
					</>
				)}
			</div>
			<footer>
				<button
					type="button"
					class="btn"
					data-variant="outline"
					commandfor="auth-dialog"
					command="close"
				>
					Close
				</button>
			</footer>
		</>,
	);
}

function renderProviderButton(
	provider: AppAuthProvider,
	mode: AppAuthDialog["mode"],
): string {
	const action = mode === "login" ? endpoints.authLoginStart : endpoints.authLogout;
	return syncHtml(
		<button
			type="button"
			class="btn dialog-option dialog-option-between"
			data-variant="ghost"
			data-show={`${JSON.stringify(providerSearchHaystack(provider))}.includes($_authSearch.trim().toLowerCase())`}
			data-on:click={`
				$authProvider = ${JSON.stringify(provider.id)};
				$authType = ${JSON.stringify(provider.authType)};
				@post('${action}', {
					payload: { authProvider: $authProvider, authType: $authType },
				});
			`}
		>
			<span class="dialog-option-text">
				<span class="dialog-option-title" safe>
					{provider.name}
				</span>
				<span class="dialog-option-description" safe>
					{provider.id}
				</span>
			</span>
			<span class="badge" data-variant="secondary">
				{provider.authType === "oauth" ? "Subscription" : "API key"}
			</span>
		</button>,
	);
}

function providerSearchHaystack(provider: AppAuthProvider): string {
	return `${provider.name} ${provider.id} ${provider.authType === "oauth" ? "subscription oauth" : "api key"}`.toLowerCase();
}

function renderAuthenticationFlow(dialog: AppAuthDialog): string {
	const hasTextPrompt = Boolean(dialog.prompt && !dialog.prompt.options);
	return syncHtml(
		<>
			<header id={`auth-phase-${dialog.phase}`} data-init={AUTH_PHASE_ENTER}>
				<h2 id="auth-dialog-title" safe>
					Log in to {dialog.providerName}
				</h2>
				{dialog.status && <p safe>{dialog.status}</p>}
			</header>
			<div class="dialog-flow">
				{dialog.url && (
					<div class="dialog-flow-compact">
						<a
							class="dialog-link"
							href={dialog.url}
							target="_blank"
							rel="noreferrer"
							safe
						>
							{dialog.url}
						</a>
						{dialog.instructions && (
							<p class="dialog-description" safe>
								{dialog.instructions}
							</p>
						)}
					</div>
				)}
				{dialog.deviceCode && (
					<div class="dialog-callout">
						<p class="dialog-description">Enter this code in the browser:</p>
						<code class="dialog-device-code" safe>
							{dialog.deviceCode}
						</code>
					</div>
				)}
				{dialog.prompt && renderAuthenticationPrompt(dialog)}
				{dialog.progress.length > 0 && (
					<div class="dialog-progress-messages">
						{dialog.progress.map((message) => (
							<p safe>{message}</p>
						))}
					</div>
				)}
				{dialog.error && (
					<p
						class="error-foreground dialog-message"
						data-init={AUTH_ERROR_ENTER}
						safe
					>
						{dialog.error}
					</p>
				)}
			</div>
			<footer>
				<button
					type="button"
					class="btn"
					data-variant="outline"
					commandfor="auth-dialog"
					command="close"
				>
					Cancel
				</button>
				{hasTextPrompt && (
					<button
						type="button"
						class="btn"
						data-indicator:_auth-submitting
						data-attr:disabled="$_authSubmitting"
						data-attr:aria-busy="$_authSubmitting ? 'true' : 'false'"
						data-on:click={postAuthInput("$authInput")}
					>
						Continue
					</button>
				)}
			</footer>
		</>,
	);
}

function renderAuthenticationPrompt(dialog: AppAuthDialog): string {
	const prompt = dialog.prompt!;
	if (prompt.options) {
		return syncHtml(
			<div class="dialog-flow-compact">
				<p class="dialog-prompt" safe>
					{prompt.message}
				</p>
				{prompt.options.map((option) => (
					<button
						type="button"
						class="btn dialog-option"
						data-variant="outline"
						data-on:click={`
							$authInput = ${JSON.stringify(option.id)};
							${postAuthInput("$authInput")}
						`}
						safe
					>
						{option.label}
					</button>
				))}
			</div>,
		);
	}
	return syncHtml(
		<div role="group" class="field" data-invalid={dialog.error ? "true" : undefined}>
			<label for="auth-input" safe>
				{prompt.message}
			</label>
			<input
				id="auth-input"
				type={prompt.secret ? "password" : "text"}
				autocomplete="off"
				spellcheck="false"
				placeholder={prompt.placeholder}
				aria-invalid={dialog.error ? "true" : undefined}
				data-bind:auth-input
				autofocus
				data-on:keydown={`if (evt.code === 'Enter') {
					evt.preventDefault();
					${postAuthInput("$authInput")}
				}`}
			/>
		</div>,
	);
}

/**
 * `document.body?.dataset?.displayClientId` — same runtime read as
 * `extension-dialog.tsx`'s `postResponse` — so the server can tell other
 * connected clients "answered elsewhere" for the auth_url/api-key/oauth
 * prompt flow too (round RM1 multi-client #1). A raw expression, not a
 * literal: this dialog is patched independently of the page's own per-render
 * template, so it can't embed a build-time id the way `page.tsx` does.
 */
function postAuthInput(value: string): string {
	return `@post('${endpoints.authInput}', { payload: {
		authInput: ${value},
		clientId: document.body?.dataset?.displayClientId,
	} })`;
}

function renderResult(dialog: AppAuthDialog): string {
	return syncHtml(
		<>
			<header id={`auth-phase-${dialog.phase}`} data-init={AUTH_RESULT_ENTER}>
				<h2 id="auth-dialog-title">
					{dialog.error ? "Authentication failed" : "Authentication updated"}
				</h2>
				<p class={dialog.error ? "error-foreground" : undefined} safe>
					{dialog.error ?? dialog.status}
				</p>
			</header>
			<footer>
				<button
					type="button"
					class="btn"
					commandfor="auth-dialog"
					command="close"
				>
					Done
				</button>
			</footer>
		</>,
	);
}
