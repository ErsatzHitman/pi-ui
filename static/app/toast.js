import { duration, easing, reducedMotion } from "./motion.js";

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
 * timer or a click. The stack glides when a toast joins or leaves it.
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
	const before = stackRects(host);
	host.append(toast);
	glideStack(before);
	setTimeout(() => dismiss(toast), dismissMs);
}

function dismiss(toast) {
	if (!toast.isConnected || toast.dataset.dismissing) return;
	toast.dataset.dismissing = "true";
	toast.addEventListener("transitionend", () => removeToast(toast), { once: true });
	setTimeout(() => removeToast(toast), transitionFallbackMs);
}

function removeToast(toast) {
	const host = toast.parentElement;
	if (!host) return;
	const before = stackRects(host, toast);
	toast.remove();
	glideStack(before);
}

// In-flight glides, so a second change restarts each toast from where it is.
const glides = new WeakMap();

function stackRects(host, leaving) {
	return host
		.querySelectorAll(".toast")
		.values()
		.filter((toast) => toast !== leaving)
		.map((toast) => ({ toast, rect: toast.getBoundingClientRect() }))
		.toArray();
}

/** FLIP: toasts the stack pushed up (or let down) glide there instead of jumping. */
function glideStack(before) {
	if (reducedMotion()) return;
	for (const { toast, rect } of before) {
		glides.get(toast)?.cancel();
		const dy = rect.top - toast.getBoundingClientRect().top;
		if (Math.abs(dy) < 0.5) continue;
		glides.set(
			toast,
			toast.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], {
				duration: duration.lg,
				easing: easing.out,
			}),
		);
	}
}
