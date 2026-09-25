const dismissMs = 4000;
/** Fallback longer than the CSS exit (160ms, `misc.css`'s `.toast[data-dismissing]`)
 * for paths where `transitionend` never fires (e.g. a backgrounded tab). */
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
	// `.toast`'s `@starting-style` animates the entry on insertion.
	host.append(toast);
	setTimeout(() => dismiss(toast), dismissMs);
}

function dismiss(toast) {
	if (!toast.isConnected || toast.dataset.dismissing) return;
	toast.dataset.dismissing = "true";
	toast.addEventListener("transitionend", () => toast.remove(), { once: true });
	setTimeout(() => toast.remove(), transitionFallbackMs);
}
