import type { GatewayEndpoint } from "./ranking.ts";

/** Vercel reports rolling one-hour medians; refetching more often than this barely moves the ranking. */
export const STATS_TTL_MS = 15 * 60_000;
/** After a failed fetch, requests go out without fastcel's ranking for this long before it tries again. */
export const RETRY_AFTER_FAILURE_MS = 60_000;
const FETCH_TIMEOUT_MS = 4_000;

export interface ModelStats {
	fetchedAt: number;
	/** Empty when the gateway lists no providers for the model. */
	endpoints: GatewayEndpoint[];
}

export interface StatsCacheOptions {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
	onError?: (url: string, error: unknown) => void;
}

/** Per-model provider stats from Vercel AI Gateway, refreshed in the background once stale. */
export class StatsCache {
	readonly #entries = new Map<string, ModelStats>();
	readonly #failedAt = new Map<string, number>();
	readonly #inflight = new Map<string, Promise<ModelStats | undefined>>();
	readonly #fetch: NonNullable<StatsCacheOptions["fetch"]>;
	readonly #now: () => number;
	readonly #onError: StatsCacheOptions["onError"];

	constructor(options: StatsCacheOptions = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#onError = options.onError;
	}

	/**
	 * Stats for one endpoints URL. A fresh entry returns at once. A stale entry returns at once while a
	 * refresh runs in the background, unless `waitForFresh` asks to wait for that refresh. Without an
	 * entry the call waits for the fetch. Resolves to the newest stats available, or `undefined` when
	 * nothing could be loaded. Never rejects.
	 */
	get(url: string, { waitForFresh = false }: { waitForFresh?: boolean } = {}): Promise<ModelStats | undefined> {
		const cached = this.#entries.get(url);
		if (cached && this.#now() - cached.fetchedAt < STATS_TTL_MS) return Promise.resolve(cached);
		const refresh = this.#refresh(url);
		return cached && !waitForFresh ? Promise.resolve(cached) : refresh;
	}

	/** Forget every entry and failure, so the next `get` fetches again. */
	clear(): void {
		this.#entries.clear();
		this.#failedAt.clear();
	}

	#refresh(url: string): Promise<ModelStats | undefined> {
		const pending = this.#inflight.get(url);
		if (pending) return pending;
		const failedAt = this.#failedAt.get(url);
		if (failedAt !== undefined && this.#now() - failedAt < RETRY_AFTER_FAILURE_MS) {
			return Promise.resolve(this.#entries.get(url));
		}
		const load = this.#load(url).finally(() => this.#inflight.delete(url));
		this.#inflight.set(url, load);
		return load;
	}

	async #load(url: string): Promise<ModelStats | undefined> {
		try {
			const response = await this.#fetch(url, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			// Variants such as `-batch` models have no endpoint list; remember that instead of asking again.
			if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
			const endpoints = response.status === 404 ? [] : parseEndpoints(await response.json());
			const stats: ModelStats = { fetchedAt: this.#now(), endpoints };
			this.#entries.set(url, stats);
			this.#failedAt.delete(url);
			return stats;
		} catch (error) {
			this.#failedAt.set(url, this.#now());
			this.#onError?.(url, error);
			return this.#entries.get(url);
		}
	}
}

function parseEndpoints(body: unknown): GatewayEndpoint[] {
	const data = typeof body === "object" && body !== null && "data" in body ? body.data : undefined;
	const endpoints = typeof data === "object" && data !== null && "endpoints" in data ? data.endpoints : undefined;
	if (!Array.isArray(endpoints)) throw new Error("response has no data.endpoints array");
	return endpoints.filter(
		(endpoint): endpoint is GatewayEndpoint =>
			typeof endpoint === "object" && endpoint !== null && typeof endpoint.provider_name === "string",
	);
}
