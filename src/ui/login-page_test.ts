import { test } from "bun:test";

import {
	assertEquals,
	assertStringIncludes,
	assertStringExcludes,
} from "#testing/assertions";

import { renderLoginPage } from "./login-page.tsx";

test("the login page posts to the given login path", () => {
	const html = renderLoginPage({ next: "/", loginPath: "/session/login" });
	assertStringIncludes(html, 'method="post"');
	assertStringIncludes(html, 'action="/session/login"');
});

test("the login page carries the return path in a hidden field", () => {
	const html = renderLoginPage({ next: "/sessions/abc", loginPath: "/session/login" });
	assertStringIncludes(html, 'name="next"');
	assertStringIncludes(html, 'value="/sessions/abc"');
});

test("the login page escapes a quote in an untrusted next value so it can't break out of the attribute", () => {
	const html = renderLoginPage({
		next: '/"><script>alert(1)</script>',
		loginPath: "/session/login",
	});
	// The literal payload would need an unescaped `"` right before `>` to close the
	// `value="..."` attribute early and start a real `<script>` tag; Kita escapes
	// attribute values, so that quote comes through encoded instead.
	assertStringExcludes(html, '"/"><script>');
	assertStringIncludes(html, "&#34;");
});

test("the login page has no error banner by default", () => {
	const html = renderLoginPage({ next: "/", loginPath: "/session/login" });
	assertStringExcludes(html, 'role="alert"');
});

test("the login page shows an escaped error message when given one", () => {
	const html = renderLoginPage({
		next: "/",
		loginPath: "/session/login",
		error: "<b>bad</b> token",
	});
	assertStringIncludes(html, 'role="alert"');
	assertStringIncludes(html, "&lt;b&gt;bad&lt;/b&gt; token");
	assertStringExcludes(html, "<b>bad</b> token");
});

test("the login page reuses the app's real stylesheet, theme script, and native classes", () => {
	const html = renderLoginPage({ next: "/", loginPath: "/session/login" });
	assertStringIncludes(html, 'href="/app.css"');
	assertStringIncludes(html, 'src="/theme.js"');
	assertStringIncludes(html, "raised-surface");
	assertStringIncludes(html, 'class="btn"');
	assertStringIncludes(html, 'name="color-scheme" content="light dark"');
	// theme.js (loaded above) unconditionally reaches for this meta tag on every theme
	// change; omitting it throws inside that script instead of just doing nothing.
	assertStringIncludes(html, 'name="theme-color"');
});

test("the login page links the PWA manifest and icons, so it's installable before signing in", () => {
	const html = renderLoginPage({ next: "/", loginPath: "/session/login" });
	assertStringIncludes(html, 'rel="manifest" href="/manifest.webmanifest"');
	assertStringIncludes(html, 'rel="apple-touch-icon" href="/icon-180.png"');
});

test("the login page starts with a doctype", () => {
	const html = renderLoginPage({ next: "/", loginPath: "/session/login" });
	assertEquals(html.startsWith("<!doctype html>"), true);
});
