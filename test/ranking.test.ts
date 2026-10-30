import { describe, expect, test } from "bun:test";
import { DEGRADED_UPTIME_PERCENT, type GatewayEndpoint, rankProviders } from "../src/ranking.ts";

function endpoint(provider: string, tps: number | null, extra: Partial<GatewayEndpoint> = {}): GatewayEndpoint {
	return {
		provider_name: provider,
		context_length: 1_000_000,
		supported_parameters: ["max_tokens", "tools", "reasoning"],
		status: 0,
		uptime_last_15m: 100,
		latency_last_1h: { p50: 800 },
		throughput_last_1h: tps === null ? null : { p50: tps },
		...extra,
	};
}

const providers = (endpoints: GatewayEndpoint[], tools = true, contextTokens?: number) =>
	rankProviders(endpoints, { tools, contextTokens }).map(entry => entry.provider);

describe("rankProviders", () => {
	test("puts the highest median throughput first and unmeasured providers last in Vercel's order", () => {
		const ranked = providers([
			endpoint("alibaba", 105),
			endpoint("cerebras", null),
			endpoint("baseten", 220),
			endpoint("groq", null),
			endpoint("wafer", 158),
		]);
		expect(ranked).toEqual(["baseten", "wafer", "alibaba", "cerebras", "groq"]);
	});

	test("moves deprecated, degraded and toolless providers behind suitable ones, fastest first within each group", () => {
		const ranking = rankProviders(
			[
				endpoint("old", 400, { status: 1, deprecated_at: "2026-11-01" }),
				endpoint("flaky", 300, { uptime_last_15m: DEGRADED_UPTIME_PERCENT - 0.1 }),
				endpoint("notools", 250, { supported_parameters: ["max_tokens"] }),
				endpoint("slow", 50),
				endpoint("steady", 60, { uptime_last_15m: DEGRADED_UPTIME_PERCENT }),
			],
			{ tools: true },
		);
		expect(ranking.map(entry => [entry.provider, entry.demotion])).toEqual([
			["steady", undefined],
			["slow", undefined],
			["old", "deprecated"],
			["flaky", "degraded (89.9% up)"],
			["notools", "no tool support"],
		]);
	});

	test("keeps toolless providers in place when the request declares no tools", () => {
		expect(providers([endpoint("slow", 50), endpoint("notools", 250, { supported_parameters: [] })], false)).toEqual([
			"notools",
			"slow",
		]);
	});

	test("demotes providers whose context window is smaller than the conversation", () => {
		const endpoints = [endpoint("small", 300, { context_length: 65_536 }), endpoint("large", 80)];
		expect(providers(endpoints, true, 65_536)).toEqual(["small", "large"]);
		expect(providers(endpoints, true, 65_537)).toEqual(["large", "small"]);
		expect(providers(endpoints, true)).toEqual(["small", "large"]);
	});

	test("lists each provider slug once, at its best position", () => {
		expect(providers([endpoint("azure", 40), endpoint("baseten", 90), endpoint("azure", 170)])).toEqual([
			"azure",
			"baseten",
		]);
	});
});
