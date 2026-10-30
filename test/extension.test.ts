import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
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

const shutdowns: Handler[] = [];

/** Load the extension against a recording stand-in and return its `before_provider_request` handler. */
async function loadRequestHook(events = new EventBus()): Promise<Handler> {
	const handlers = new Map<string, Handler>();
	const recorder = {
		setLabel() {},
		logger: { warn() {} },
		events,
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	};
	// The stand-in implements only the members the factory touches; ExtensionAPI has dozens more.
	await fastcel(recorder as unknown as ExtensionAPI);
	const shutdown = handlers.get("session_shutdown");
	if (shutdown) shutdowns.push(shutdown);
	const hook = handlers.get("before_provider_request");
	if (!hook) throw new Error("fastcel registered no before_provider_request handler");
	return hook;
}

/** A session context whose UI calls land in `shown` as `[surface, content]` pairs. */
function contextFor(model: object, shown: Array<[string, unknown]> = []) {
	return {
		model,
		models: { current: () => model },
		agent: { kind: "main" },
		ui: {
			setStatus: (_key: string, text: unknown) => shown.push(["status", text]),
			setWidget: (_key: string, lines: unknown) => shown.push(["widget", lines]),
		},
		setTimeout: (callback: () => void) => callback(),
		getContextUsage: () => ({ tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 }),
	};
}

const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => {
	fetchSpy.mockReset();
	setNativeRendering(false);
	for (const shutdown of shutdowns.splice(0)) shutdown({ type: "session_shutdown" }, undefined);
});

describe("before_provider_request", () => {
	test("orders a gateway request fastest provider first and keeps the other provider options", async () => {
		fetchSpy.mockResolvedValue(Response.json({ data: { endpoints: ENDPOINTS } }));
		const payload = {
			model: "deepseek/deepseek-v4-flash",
			max_tokens: 384_000,
			tools: [{ name: "bash" }],
			providerOptions: { gateway: { caching: "auto" }, anthropic: { thinking: { type: "adaptive" } } },
		};

		const hook = await loadRequestHook();
		const result = await hook({ type: "before_provider_request", payload }, contextFor(gatewayModel));

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
		const hook = await loadRequestHook();
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

		const hook = await loadRequestHook();
		const result = await hook({ type: "before_provider_request", payload }, contextFor(pinnedModel));

		expect(result).toEqual({ ...payload, providerOptions: { gateway: { only: ["wafer"] } } });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("shows the pick in the status line, and under the composer while Tern renders natively", async () => {
		fetchSpy.mockResolvedValue(Response.json({ data: { endpoints: ENDPOINTS } }));
		const shown: Array<[string, unknown]> = [];
		const hook = await loadRequestHook();

		await hook({ type: "before_provider_request", payload: { model: gatewayModel.id } }, contextFor(gatewayModel, shown));
		const [[surface, text] = []] = shown;
		expect(surface).toBe("status");
		expect(text).toContain("baseten");

		setNativeRendering(true);
		expect(shown.slice(1)).toEqual([
			["status", undefined],
			["widget", [text]],
		]);

		setNativeRendering(false);
		expect(shown.slice(3)).toEqual([
			["widget", undefined],
			["status", text],
		]);
	});

	test("hands the pick to plugins drawing an indicator line, and takes it back when the last one stops", async () => {
		fetchSpy.mockResolvedValue(Response.json({ data: { endpoints: ENDPOINTS } }));
		const events = new EventBus();
		const items: unknown[] = [];
		events.on("indicator-line:query", () => events.emit("indicator-line:host", { id: "main" }));
		events.on("indicator-line:item", item => items.push(item));
		const shown: Array<[string, unknown]> = [];
		const hook = await loadRequestHook(events);
		// A subagent session loads its own copy of the host on the same bus.
		events.emit("indicator-line:host", { id: "subagent" });

		await hook({ type: "before_provider_request", payload: { model: gatewayModel.id } }, contextFor(gatewayModel, shown));
		expect(shown).toEqual([]);
		expect(items).toEqual([{ key: "fastcel", text: expect.stringContaining("baseten") }]);

		events.emit("indicator-line:host", { id: "subagent", active: false });
		expect(items).toHaveLength(1);
		expect(shown).toEqual([]);

		events.emit("indicator-line:host", { id: "main", active: false });
		expect(items.at(-1)).toEqual({ key: "fastcel", text: undefined });
		expect(shown).toEqual([["status", expect.stringContaining("baseten")]]);
	});
});
