// Bounds brute-force guessing of the auth token (see request-auth.ts): each wrong
// attempt from a client IP is recorded, and once maxFailures land within windowMs that
// IP is refused with 429 until the oldest of them ages out of the window. A correct
// token always succeeds — it clears that IP's count instead of being blocked by it — so
// this only slows down guessing, never a legitimate holder who mistyped it earlier.

export interface RateLimitStatus {
	blocked: boolean;
	/** Seconds until the oldest failure in the window ages out. 0 when not blocked. */
	retryAfterSeconds: number;
}

export interface AuthRateLimiterOptions {
	/** Failures allowed within `windowMs` before an IP is blocked. @default 10 */
	maxFailures?: number;
	/** @default 5 minutes */
	windowMs?: number;
	/** Bounds memory: the least-recently-touched IP is evicted past this. @default 2000 */
	maxTrackedIps?: number;
	/** Injectable clock for tests. @default Date.now */
	now?: () => number;
}

export class AuthRateLimiter {
	private readonly maxFailures: number;
	private readonly windowMs: number;
	private readonly maxTrackedIps: number;
	private readonly now: () => number;
	// Insertion order doubles as least-recently-touched order: recordFailure always
	// re-inserts the key, so the map's first key is always the one to evict.
	private readonly failures = new Map<string, number[]>();

	constructor(options: AuthRateLimiterOptions = {}) {
		this.maxFailures = options.maxFailures ?? 10;
		this.windowMs = options.windowMs ?? 5 * 60 * 1000;
		this.maxTrackedIps = options.maxTrackedIps ?? 2000;
		this.now = options.now ?? Date.now;
	}

	isBlocked(ip: string): RateLimitStatus {
		const timestamps = this.prune(ip);
		if (timestamps.length < this.maxFailures) {
			return { blocked: false, retryAfterSeconds: 0 };
		}
		const oldest = timestamps[0] ?? this.now();
		const retryAfterSeconds = Math.max(
			0,
			Math.ceil((oldest + this.windowMs - this.now()) / 1000),
		);
		return { blocked: true, retryAfterSeconds };
	}

	recordFailure(ip: string): void {
		const timestamps = this.prune(ip);
		timestamps.push(this.now());
		// Delete-then-set moves this key to the end, marking it most-recently-touched.
		this.failures.delete(ip);
		this.failures.set(ip, timestamps);
		this.evictOldestBeyondCapacity();
	}

	recordSuccess(ip: string): void {
		this.failures.delete(ip);
	}

	private prune(ip: string): number[] {
		const cutoff = this.now() - this.windowMs;
		const existing = this.failures.get(ip) ?? [];
		const kept = existing.filter((timestamp) => timestamp > cutoff);
		if (kept.length !== existing.length) {
			if (kept.length === 0) this.failures.delete(ip);
			else this.failures.set(ip, kept);
		}
		return kept;
	}

	private evictOldestBeyondCapacity(): void {
		while (this.failures.size > this.maxTrackedIps) {
			const oldestKey = this.failures.keys().next().value;
			if (oldestKey === undefined) return;
			this.failures.delete(oldestKey);
		}
	}
}
