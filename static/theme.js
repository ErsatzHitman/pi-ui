window.addEventListener("pi-ui-theme-mode-changed", () => {
	const dark = document.documentElement.classList.contains("dark");
	// Match --surface-canvas in tokens.css (light: --gray-1, dark: black).
	document.querySelector('meta[name="theme-color"]').content = dark
		? "black"
		: "oklch(95% 0 none)";
});

try {
	const media = matchMedia("(prefers-color-scheme: dark)");
	const resolveDark = () => {
		const stored = localStorage.getItem("themeMode");
		return stored ? stored === "dark" : media.matches;
	};
	const apply = () => {
		document.documentElement.classList.toggle("dark", resolveDark());
		window.dispatchEvent(new Event("pi-ui-theme-mode-changed"));
	};
	apply();
	// Later scheme flips crossfade the whole viewport (apple-design: no abrupt brightness jumps).
	// Never on first paint, and never while another View Transition (none planned) runs.
	// A classic script (it must run before first paint), so it cannot import motion.js;
	// this mirrors motion.js themeTransition(), which the in-app theme switch uses.
	// `document.activeViewTransition` is not Baseline; missing, it is a correct falsy guard.
	// A flip that keeps the resolved scheme (an OS change under an explicit light/dark
	// choice, a cross-tab preference change) applies plainly: a transition would snapshot
	// the viewport and swallow clicks for its duration with nothing to blend.
	const applyAnimated = () => {
		const root = document.documentElement;
		if (
			root.classList.contains("dark") === resolveDark() ||
			!document.startViewTransition ||
			document.activeViewTransition ||
			document.hidden
		) {
			apply();
			return;
		}
		root.setAttribute("data-vt", "theme");
		const transition = document.startViewTransition(apply);
		const done = () => root.removeAttribute("data-vt");
		transition.finished.then(done, done);
	};
	media.addEventListener("change", applyAnimated);
	window.addEventListener("storage", (event) => {
		if (event.key === "themeMode") {
			applyAnimated();
		}
	});
} catch {
	// Keep first paint working if storage or media queries are unavailable.
}
