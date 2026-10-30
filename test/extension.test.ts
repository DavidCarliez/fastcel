import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import fastcel from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const ENDPOINTS = [
	{ provider_name: "alibaba", throughput_last_1h: { p50: 105 } },
	{ provider_name: "baseten", throughput_last_1h: { p50: 220 } },
	{ provider_name: "wafer", throughput_last_1h: { p50: 158 } },
];

const gatewayModel = {
	id: "deepseek/deepseek-v4-flash",
	provider: "vercel-ai-gateway",
	api: "anthropic-messages",
	baseUrl: "https://ai-gateway.vercel.sh",
};

/** Load the extension against a recording stand-in and return its `before_provider_request` handler. */
function loadRequestHook(): Handler {
	const handlers = new Map<string, Handler>();
	const recorder = {
		setLabel() {},
		logger: { warn() {} },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	};
	// The stand-in implements only the members the factory touches; ExtensionAPI has dozens more.
	fastcel(recorder as unknown as ExtensionAPI);
	const hook = handlers.get("before_provider_request");
	if (!hook) throw new Error("fastcel registered no before_provider_request handler");
	return hook;
}

function contextFor(model: object) {
	return {
		model,
		models: { current: () => model },
		agent: { kind: "main" },
		ui: { setStatus() {} },
		getContextUsage: () => ({ tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 }),
	};
}

const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => fetchSpy.mockReset());

describe("before_provider_request", () => {
	test("orders a gateway request fastest provider first and keeps the other provider options", async () => {
		fetchSpy.mockResolvedValue(Response.json({ data: { endpoints: ENDPOINTS } }));
		const payload = {
			model: "deepseek/deepseek-v4-flash",
			max_tokens: 384_000,
			tools: [{ name: "bash" }],
			providerOptions: { gateway: { caching: "auto" }, anthropic: { thinking: { type: "adaptive" } } },
		};

		const result = await loadRequestHook()({ type: "before_provider_request", payload }, contextFor(gatewayModel));

		expect(result).toEqual({
			...payload,
			providerOptions: {
				gateway: { caching: "auto", order: ["baseten", "wafer", "alibaba"] },
				anthropic: { thinking: { type: "adaptive" } },
			},
		});
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://ai-gateway.vercel.sh/v1/models/deepseek/deepseek-v4-flash/endpoints",
		);
	});

	test("leaves alone requests that already carry routing or do not go through the gateway", async () => {
		const hook = loadRequestHook();
		const routed = { model: "deepseek/deepseek-v4-flash", providerOptions: { gateway: { only: ["novita"] } } };
		expect(await hook({ type: "before_provider_request", payload: routed }, contextFor(gatewayModel))).toBeUndefined();

		const direct = { ...gatewayModel, provider: "deepseek", baseUrl: "https://api.deepseek.com/anthropic" };
		const payload = { model: "deepseek-v4-flash" };
		expect(await hook({ type: "before_provider_request", payload }, contextFor(direct))).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("sends a model@provider pin as configured instead of ranking", async () => {
		const pinnedModel = { ...gatewayModel, compatConfig: { vercelGatewayRouting: { only: ["wafer"] } } };
		const payload = { model: "deepseek/deepseek-v4-flash" };

		const result = await loadRequestHook()({ type: "before_provider_request", payload }, contextFor(pinnedModel));

		expect(result).toEqual({ ...payload, providerOptions: { gateway: { only: ["wafer"] } } });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
