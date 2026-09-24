import { appDataPath } from "../../utils/app-dirs.ts";
/**
 * Persists the phone/desktop `PushSubscription`s the client registered
 * (`static/app/push.js`, `routes/push.ts`) so a "session finished" push can be
 * sent even with no server process restart in between. Bounded, since a
 * subscription is only ever added through an authenticated `/push/subscribe`
 * POST but the file is still attacker-adjacent data at rest: an unbounded list
 * would let a compromised or buggy client grow it forever.
 */
import { isNotFound } from "../../utils/fs-errors.ts";
import { writeSecretFile } from "../../utils/secret-file.ts";

export interface PushSubscriptionRecord {
	readonly endpoint: string;
	readonly p256dh: string;
	readonly auth: string;
}

/** Well under any push service's realistic per-user device count; bounds the
 * file and the number of pushes one "session finished" event fans out to. */
const maxSubscriptions = 20;

function isPushSubscriptionRecord(value: unknown): value is PushSubscriptionRecord {
	if (!value || typeof value !== "object") return false;
	// SAFETY: only used for `typeof === "string"` checks below; the function
	// returns false unless every one passes, so a value that isn't actually a
	// `PushSubscriptionRecord` is never treated as one by any caller.
	const record = value as Partial<PushSubscriptionRecord>;
	return (
		typeof record.endpoint === "string" &&
		typeof record.p256dh === "string" &&
		typeof record.auth === "string"
	);
}

export function pushSubscriptionsPath(): string {
	return appDataPath("push-subscriptions.json");
}

export class PushSubscriptionStore {
	private readonly subscriptions = new Map<string, PushSubscriptionRecord>();
	private loaded: Promise<void> | undefined;
	private pendingWrite = Promise.resolve();

	constructor(private readonly path: string = pushSubscriptionsPath()) {}

	private ensureLoaded(): Promise<void> {
		return (this.loaded ??= this.load());
	}

	private async load(): Promise<void> {
		let text: string;
		try {
			text = await Bun.file(this.path).text();
		} catch (error) {
			if (isNotFound(error)) return;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (!Array.isArray(parsed)) return;
		for (const entry of parsed) {
			if (isPushSubscriptionRecord(entry))
				this.subscriptions.set(entry.endpoint, entry);
		}
	}

	/** Adds or replaces the subscription for `record.endpoint`, evicting the
	 * least-recently-added entry once the bound is exceeded. */
	async add(record: PushSubscriptionRecord): Promise<void> {
		await this.ensureLoaded();
		this.subscriptions.delete(record.endpoint);
		this.subscriptions.set(record.endpoint, record);
		while (this.subscriptions.size > maxSubscriptions) {
			const oldest = this.subscriptions.keys().next().value;
			if (oldest === undefined) break;
			this.subscriptions.delete(oldest);
		}
		await this.persist();
	}

	/** Removes a subscription — called on an explicit client unsubscribe, and by
	 * `send-push.ts` when the push service reports the endpoint gone (404/410). */
	async remove(endpoint: string): Promise<void> {
		await this.ensureLoaded();
		if (this.subscriptions.delete(endpoint)) await this.persist();
	}

	async list(): Promise<readonly PushSubscriptionRecord[]> {
		await this.ensureLoaded();
		return [...this.subscriptions.values()];
	}

	private async persist(): Promise<void> {
		const snapshot = JSON.stringify([...this.subscriptions.values()]);
		const write = this.pendingWrite.then(() => writeSecretFile(this.path, snapshot));
		this.pendingWrite = write.catch(() => {});
		await write;
	}
}
