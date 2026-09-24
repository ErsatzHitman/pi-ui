import { test } from "bun:test";

import { assertEquals } from "#testing/assertions";

import { AuthRateLimiter } from "./auth-rate-limit.ts";

test("an IP is not blocked below the failure threshold", () => {
	const limiter = new AuthRateLimiter({ maxFailures: 3 });
	limiter.recordFailure("1.2.3.4");
	limiter.recordFailure("1.2.3.4");
	assertEquals(limiter.isBlocked("1.2.3.4").blocked, false);
});

test("an IP is blocked once it reaches the failure threshold within the window", () => {
	const limiter = new AuthRateLimiter({ maxFailures: 3 });
	limiter.recordFailure("1.2.3.4");
	limiter.recordFailure("1.2.3.4");
	limiter.recordFailure("1.2.3.4");
	const status = limiter.isBlocked("1.2.3.4");
	assertEquals(status.blocked, true);
	assertEquals(status.retryAfterSeconds > 0, true);
});

test("other IPs are unaffected by one IP's failures", () => {
	const limiter = new AuthRateLimiter({ maxFailures: 1 });
	limiter.recordFailure("1.2.3.4");
	assertEquals(limiter.isBlocked("5.6.7.8").blocked, false);
});

test("a success clears the failure count for that IP", () => {
	const limiter = new AuthRateLimiter({ maxFailures: 2 });
	limiter.recordFailure("1.2.3.4");
	limiter.recordSuccess("1.2.3.4");
	limiter.recordFailure("1.2.3.4");
	assertEquals(limiter.isBlocked("1.2.3.4").blocked, false);
});

test("failures older than the window expire and unblock the IP", () => {
	let now = 0;
	const limiter = new AuthRateLimiter({
		maxFailures: 2,
		windowMs: 1000,
		now: () => now,
	});
	limiter.recordFailure("1.2.3.4");
	limiter.recordFailure("1.2.3.4");
	assertEquals(limiter.isBlocked("1.2.3.4").blocked, true);
	now = 1001;
	assertEquals(limiter.isBlocked("1.2.3.4").blocked, false);
});

test("retryAfterSeconds counts down to the window's expiry", () => {
	let now = 0;
	const limiter = new AuthRateLimiter({
		maxFailures: 1,
		windowMs: 10_000,
		now: () => now,
	});
	limiter.recordFailure("1.2.3.4");
	assertEquals(limiter.isBlocked("1.2.3.4").retryAfterSeconds, 10);
	now = 4000;
	assertEquals(limiter.isBlocked("1.2.3.4").retryAfterSeconds, 6);
});

test("memory is bounded: tracking evicts the least-recently-touched IP", () => {
	const limiter = new AuthRateLimiter({ maxFailures: 1, maxTrackedIps: 2 });
	limiter.recordFailure("1.1.1.1");
	limiter.recordFailure("2.2.2.2");
	limiter.recordFailure("3.3.3.3");
	// "1.1.1.1" was least recently touched, so it was evicted and is no longer blocked.
	assertEquals(limiter.isBlocked("1.1.1.1").blocked, false);
	assertEquals(limiter.isBlocked("2.2.2.2").blocked, true);
	assertEquals(limiter.isBlocked("3.3.3.3").blocked, true);
});
