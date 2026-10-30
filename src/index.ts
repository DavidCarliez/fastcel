import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as NativeRenderingState from "@oh-my-pi/pi-tui/native/state";
import { type RankedProvider, rankProviders } from "./ranking.ts";
import { type ModelStats, StatsCache } from "./stats.ts";

const GATEWAY_HOST = "ai-gateway.vercel.sh";
const INDICATOR_KEY = "fastcel";
const LOOKUP_TIMEOUT_MS = 4_000;

type Model = NonNullable<ExtensionContext["model"]>;
type JsonObject = Record<string, unknown>;

/** Routing the user asked for: a `model@provider` selector or `compat.vercelGatewayRouting` in models.yml. */
interface PinnedRouting {
	only?: string[];
	order?: string[];
}

export default async function fastcel(pi: ExtensionAPI): Promise<void> {
	pi.setLabel("fastcel");
	const stats = new StatsCache({
		onError: (url, error) => pi.logger.warn("fastcel: could not load provider stats", { url, error: String(error) }),
	});

	// A plain terminal prints extension statuses on lines of their own under the status line. Tern's native
	// view puts them last among the composer's facts and hides them first once usage figures fill that row,
	// so while it renders, the pick goes on a row under the composer instead.
	const nativeRendering = await loadNativeRenderingState();
	let shown: { text: string | undefined; native: boolean } = { text: undefined, native: false };
	let indicatorCtx: ExtensionContext | undefined;
	const showIndicator = (ctx: ExtensionContext, text: string | undefined): void => {
		indicatorCtx = ctx;
		const native = nativeRendering?.isNativeRendering() ?? false;
		if (shown.text === text && shown.native === native) return;
		if (shown.text !== undefined) {
			if (shown.native) ctx.ui.setWidget(INDICATOR_KEY, undefined);
			else ctx.ui.setStatus(INDICATOR_KEY, undefined);
		}
		if (text !== undefined) {
			if (native) ctx.ui.setWidget(INDICATOR_KEY, [text], { placement: "belowEditor" });
			else ctx.ui.setStatus(INDICATOR_KEY, text);
		}
		shown = { text, native };
	};
	// Tern can open or close its native view while omp runs; move the pick along with it.
	const stopWatchingNative = nativeRendering?.onNativeRenderingChange(() => {
		const ctx = indicatorCtx;
		ctx?.setTimeout(() => showIndicator(ctx, shown.text), 0);
	});
	pi.on("session_shutdown", () => stopWatchingNative?.());

	// Warm the cache off the startup path so the first request does not wait, and show the pick early.
	const showPickEarly = (ctx: ExtensionContext): void => {
		const model = ctx.models.current();
		const origin = gatewayOrigin(model);
		if (!model || !origin || ctx.agent.kind !== "main") return;
		ctx.setTimeout(async () => {
			const pinned = pinnedRouting(model);
			const modelStats = pinned ? undefined : await stats.get(endpointsUrl(origin, model.id));
			if (!sameModel(ctx.models.current(), model)) return;
			const ranking = modelStats && rankProviders(modelStats.endpoints, { tools: true });
			showIndicator(ctx, indicatorText(model.id, pinned, ranking));
		}, 0);
	};
	pi.on("session_start", (_event, ctx) => showPickEarly(ctx));
	// OMP drops extension widgets when it starts or resumes another session; clear the status too and redraw.
	pi.on("session_switch", (_event, ctx) => {
		if (shown.text !== undefined && !shown.native) ctx.ui.setStatus(INDICATOR_KEY, undefined);
		shown = { text: undefined, native: false };
		showPickEarly(ctx);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		const origin = gatewayOrigin(model);
		const ownsIndicator = ctx.agent.kind === "main" && sameModel(ctx.models.current(), model);
		const payload = event.payload;
		if (!model || !origin || !isObject(payload)) {
			if (ownsIndicator) showIndicator(ctx, undefined);
			return;
		}
		const providerOptions = isObject(payload.providerOptions) ? payload.providerOptions : {};
		const gateway = isObject(providerOptions.gateway) ? providerOptions.gateway : {};
		if (gateway.only !== undefined || gateway.order !== undefined) {
			// OMP or another extension already routed this request.
			if (ownsIndicator) showIndicator(ctx, undefined);
			return;
		}

		const pinned = pinnedRouting(model);
		const modelId = typeof payload.model === "string" ? payload.model : model.id;
		let ranking: RankedProvider[] | undefined;
		if (!pinned) {
			const modelStats = await stats.get(endpointsUrl(origin, modelId));
			ranking =
				modelStats &&
				rankProviders(modelStats.endpoints, {
					tools: Array.isArray(payload.tools) && payload.tools.length > 0,
					contextTokens: ctx.getContextUsage()?.tokens,
				});
		}
		if (ownsIndicator) showIndicator(ctx, indicatorText(modelId, pinned, ranking));

		// With fewer than two providers there is nothing to choose; Vercel's default is the only option.
		const routing = pinned ?? (ranking && ranking.length > 1 ? { order: ranking.map(entry => entry.provider) } : undefined);
		if (!routing) return;
		return { ...payload, providerOptions: { ...providerOptions, gateway: { ...gateway, ...routing } } };
	});

	pi.registerCommand("fastcel", {
		description: "Rank the Vercel AI Gateway providers of a model by live throughput: /fastcel [model-id | refresh]",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "refresh") stats.clear();
			const current = ctx.models.current();
			const currentOrigin = gatewayOrigin(current);
			const requested = arg === "" || arg === "refresh" ? undefined : arg.replace(/^vercel-ai-gateway\//, "");
			const modelId = requested ?? (currentOrigin ? current?.id : undefined);
			if (!modelId) {
				ctx.ui.notify(
					"fastcel: the current model does not go through Vercel AI Gateway. Name one: /fastcel deepseek/deepseek-v4-flash",
					"warning",
				);
				return;
			}
			const origin = currentOrigin ?? `https://${GATEWAY_HOST}`;
			const modelStats = await stats.get(endpointsUrl(origin, modelId), { waitForFresh: true });
			if (!modelStats) {
				ctx.ui.notify(`fastcel: could not load provider stats for ${modelId}; see the omp log.`, "error");
				return;
			}
			if (modelStats.endpoints.length === 0) {
				ctx.ui.notify(`fastcel: Vercel AI Gateway lists no providers for ${modelId}.`, "warning");
				return;
			}
			const isCurrent = current !== undefined && currentOrigin !== undefined && current.id === modelId;
			const ranking = rankProviders(modelStats.endpoints, {
				tools: true,
				contextTokens: isCurrent ? ctx.getContextUsage()?.tokens : undefined,
			});
			const lines = formatRanking(modelId, modelStats, ranking);
			if (isCurrent) {
				const pinned = pinnedRouting(current);
				if (pinned) lines.push(`Routing pinned by your config (${describePin(pinned)}); fastcel leaves it as is.`);
				const served = await lastServedProvider(ctx, current, origin).catch(() => undefined);
				if (served && "provider" in served) lines.push(`Last reply was served by ${served.provider}.`);
				if (served && "pending" in served) {
					lines.push("Vercel has not published which provider served the last reply yet; ask again in a minute.");
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/**
 * OMP's process-wide flag for Tern's native view. It is an internal OMP module that another OMP version may
 * move, so it is imported at runtime and its absence only means the pick stays in the status line.
 */
async function loadNativeRenderingState(): Promise<typeof NativeRenderingState | undefined> {
	try {
		return await import("@oh-my-pi/pi-tui/native/state");
	} catch {
		return undefined;
	}
}

/** Origin of Vercel AI Gateway when the model is served through it. */
function gatewayOrigin(model: Model | undefined): string | undefined {
	if (!model?.baseUrl || !URL.canParse(model.baseUrl)) return undefined;
	const url = new URL(model.baseUrl);
	return url.hostname === GATEWAY_HOST ? url.origin : undefined;
}

function endpointsUrl(origin: string, modelId: string): string {
	return `${origin}/v1/models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`;
}

/**
 * OMP keeps `model@provider` selectors and models.yml routing in `compatConfig`. On the Anthropic Messages
 * route, which OMP uses for every Vercel model, it does not send them, so fastcel applies them instead of
 * its own ranking.
 */
function pinnedRouting(model: Model): PinnedRouting | undefined {
	const sources: unknown[] = [model.compatConfig, model.compat];
	for (const source of sources) {
		if (!isObject(source) || !isObject(source.vercelGatewayRouting)) continue;
		const { only, order } = source.vercelGatewayRouting;
		const routing: PinnedRouting = {};
		if (isStringList(only)) routing.only = only;
		if (isStringList(order)) routing.order = order;
		if (routing.only || routing.order) return routing;
	}
	return undefined;
}

/**
 * `fastcel → provider togetherai · 187 tok/s`. A provider that shares its slug with the model's maker, such as
 * `deepseek` for `deepseek/…`, is the maker's own API; the label says so, since its name reads like the model's.
 */
function indicatorText(
	modelId: string,
	pinned: PinnedRouting | undefined,
	ranking: RankedProvider[] | undefined,
): string | undefined {
	if (pinned) return `fastcel: pinned ${describePin(pinned)}`;
	const leader = ranking?.[0];
	if (!leader) return undefined;
	const firstParty = leader.provider === modelId.split("/")[0] ? " (first-party)" : "";
	const speed = leader.tps === undefined ? "" : ` · ${Math.round(leader.tps)} tok/s`;
	return `fastcel → provider ${leader.provider}${firstParty}${speed}`;
}

function describePin(pinned: PinnedRouting): string {
	return [pinned.only && `only ${pinned.only.join(", ")}`, pinned.order && `order ${pinned.order.join(", ")}`]
		.filter(Boolean)
		.join("; ");
}

function formatRanking(modelId: string, modelStats: ModelStats, ranking: RankedProvider[]): string[] {
	const ageMinutes = Math.floor((Date.now() - modelStats.fetchedAt) / 60_000);
	const width = Math.max(...ranking.map(entry => entry.provider.length));
	const lines = [`fastcel · ${modelId} · live stats, ${ageMinutes < 1 ? "just fetched" : `${ageMinutes} min old`}`];
	for (const [index, entry] of ranking.entries()) {
		const tps = entry.tps === undefined ? "  n/a tok/s" : `${String(Math.round(entry.tps)).padStart(5)} tok/s`;
		const ttft = entry.ttftMs === undefined ? "n/a" : `${Math.round(entry.ttftMs)} ms`;
		const uptime = entry.uptime15m === undefined ? "n/a" : `${entry.uptime15m.toFixed(1)}%`;
		const demotion = entry.demotion ? `  [${entry.demotion}]` : "";
		const firstParty = entry.provider === modelId.split("/")[0] ? "  (first-party)" : "";
		lines.push(
			`${String(index + 1).padStart(2)}. ${entry.provider.padEnd(width)} ${tps}  ttft ${ttft.padStart(7)}  up ${uptime}${demotion}${firstParty}`,
		);
	}
	if (ranking.length === 1) lines.push("Only one provider serves this model; there is nothing to choose.");
	return lines;
}

/**
 * Provider that served the latest reply from `model` in this branch, from Vercel's generation lookup.
 * Vercel publishes a generation's record up to about a minute after the reply; until then it is pending.
 */
async function lastServedProvider(
	ctx: ExtensionContext,
	model: Model,
	origin: string,
): Promise<{ provider: string } | { pending: true } | undefined> {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (message.provider !== model.provider || message.model !== model.id) continue;
		const generationId = message.responseId;
		if (!generationId?.startsWith("gen_")) return undefined;
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) return undefined;
		const response = await fetch(`${origin}/v1/generation?id=${encodeURIComponent(generationId)}`, {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
		if (response.status === 404) return { pending: true };
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		const data = isObject(body) && isObject(body.data) ? body.data : undefined;
		return typeof data?.provider_name === "string" ? { provider: data.provider_name } : undefined;
	}
	return undefined;
}

function sameModel(a: Model | undefined, b: Model | undefined): boolean {
	return a !== undefined && b !== undefined && a.provider === b.provider && a.id === b.id;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item !== "");
}
