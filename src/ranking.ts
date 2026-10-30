/**
 * One provider endpoint from `GET /v1/models/{creator}/{model}/endpoints` on Vercel AI Gateway.
 * Only the fields fastcel reads are declared; Vercel sends more.
 */
export interface GatewayEndpoint {
	provider_name: string;
	context_length?: number | null;
	supported_parameters?: string[] | null;
	/** 0 for a normal endpoint. Vercel reports 1 for deprecated endpoints. */
	status?: number | null;
	deprecated_at?: string | null;
	uptime_last_15m?: number | null;
	latency_last_1h?: { p50?: number | null } | null;
	throughput_last_1h?: { p50?: number | null } | null;
}

/** What the outgoing request needs from a provider. */
export interface RequestNeeds {
	/** The request declares tools. */
	tools: boolean;
	/** Tokens already in the conversation, when the session knows it. */
	contextTokens?: number;
}

export interface RankedProvider {
	/** Vercel provider slug, the value `providerOptions.gateway.order` takes. */
	provider: string;
	/** Median output tokens per second over the last hour; undefined when Vercel has no samples. */
	tps?: number;
	/** Median time to first token over the last hour, in milliseconds. */
	ttftMs?: number;
	/** Percentage of successful requests over the last 15 minutes. */
	uptime15m?: number;
	/** Why the provider sits behind every provider that suits the request. */
	demotion?: string;
}

/** Uptime under this percentage over the last 15 minutes marks a provider as degraded. */
export const DEGRADED_UPTIME_PERCENT = 90;

/**
 * Order a model's providers fastest first by live median throughput.
 *
 * Providers that are deprecated, degraded, lack tool support for a request with tools, or cannot hold
 * the conversation go after every suitable provider; each group is ordered by throughput, and providers
 * without throughput samples follow the measured ones in the order Vercel listed them.
 */
export function rankProviders(endpoints: readonly GatewayEndpoint[], needs: RequestNeeds): RankedProvider[] {
	const candidates = endpoints
		.filter(endpoint => typeof endpoint.provider_name === "string" && endpoint.provider_name !== "")
		.map(endpoint => toRanked(endpoint, needs));
	candidates.sort(
		(a, b) => Number(a.demotion !== undefined) - Number(b.demotion !== undefined) || (b.tps ?? -1) - (a.tps ?? -1),
	);
	const seen = new Set<string>();
	return candidates.filter(candidate => {
		if (seen.has(candidate.provider)) return false;
		seen.add(candidate.provider);
		return true;
	});
}

function toRanked(endpoint: GatewayEndpoint, needs: RequestNeeds): RankedProvider {
	const ranked: RankedProvider = { provider: endpoint.provider_name };
	const tps = finite(endpoint.throughput_last_1h?.p50);
	const ttftMs = finite(endpoint.latency_last_1h?.p50);
	const uptime15m = finite(endpoint.uptime_last_15m);
	const demotion = demotionReason(endpoint, needs, uptime15m);
	if (tps !== undefined) ranked.tps = tps;
	if (ttftMs !== undefined) ranked.ttftMs = ttftMs;
	if (uptime15m !== undefined) ranked.uptime15m = uptime15m;
	if (demotion !== undefined) ranked.demotion = demotion;
	return ranked;
}

function demotionReason(endpoint: GatewayEndpoint, needs: RequestNeeds, uptime15m: number | undefined): string | undefined {
	if (endpoint.deprecated_at) return "deprecated";
	if (typeof endpoint.status === "number" && endpoint.status !== 0) return `status ${endpoint.status}`;
	if (uptime15m !== undefined && uptime15m < DEGRADED_UPTIME_PERCENT) return `degraded (${uptime15m.toFixed(1)}% up)`;
	if (needs.tools && Array.isArray(endpoint.supported_parameters) && !endpoint.supported_parameters.includes("tools")) {
		return "no tool support";
	}
	const contextLength = finite(endpoint.context_length);
	if (needs.contextTokens !== undefined && contextLength !== undefined && contextLength > 0 && contextLength < needs.contextTokens) {
		return `context ${contextLength} < ${needs.contextTokens}`;
	}
	return undefined;
}

function finite(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
