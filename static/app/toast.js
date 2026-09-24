const dismissMs = 4000;
/** Matches the CSS transition duration in `misc.css`'s `.toast` rule, as a
 * fallback for browsers/paths where `transitionend` never fires (reduced
 * motion, a backgrounded tab). */
const transitionFallbackMs = 400;

function region() {
	return document.getElementById("toast-region");
}

/**
 * Shows a brief, auto-dismissing native-looking toast. Currently only used
 * for "Answered on another device" (round RM1 multi-client #1), broadcast
 * over the same SSE stream as every other patch — see `ui-renderer.ts`'s
 * "toast" commit effect, which is what calls `window.piUi.toast.show(...)`.
 * Multiple toasts stack (newest at the bottom); each dismisses itself on a
 * timer or a click.
 */
export function showToast(message) {
	const host = region();
	if (!host) return;
	const toast = document.createElement("div");
	toast.className = "toast";
	toast.setAttribute("role", "status");
	toast.textContent = message;
	toast.addEventListener("click", () => dismiss(toast));
	host.append(toast);
	// Start hidden (see `.toast`'s base `opacity: 0`) and let that paint before
	// animating in, so the transition actually runs instead of being skipped.
	requestAnimationFrame(() => toast.classList.add("toast-visible"));
	setTimeout(() => dismiss(toast), dismissMs);
}

function dismiss(toast) {
	if (!toast.isConnected || toast.dataset.dismissing) return;
	toast.dataset.dismissing = "true";
	toast.classList.remove("toast-visible");
	toast.addEventListener("transitionend", () => toast.remove(), { once: true });
	setTimeout(() => toast.remove(), transitionFallbackMs);
}
