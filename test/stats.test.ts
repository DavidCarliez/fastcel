import { describe, expect, test } from "bun:test";
import { RETRY_AFTER_FAILURE_MS, STATS_TTL_MS, StatsCache } from "../src/stats.ts";

const URL = "https://ai-gateway.vercel.sh/v1/models/deepseek/deepseek-v4-flash/endpoints";

function body(...providers: string[]): Response {
	return Response.json({ data: { endpoints: providers.map(provider_name => ({ provider_name })) } });
}

/** A cache over a scripted fetch: each call takes the next response (or error) from `replies`. */
function harness(...replies: Array<Response | Error>) {
	const clock = { now: 1_000_000 };
	let calls = 0;
	const cache = new StatsCache({
		now: () => clock.now,
		fetch: async () => {
			const reply = replies[calls++];
			if (reply === undefined) throw new Error("unexpected fetch");
			if (reply instanceof Error) throw reply;
			return reply;
		},
	});
	const providers = async (waitForFresh = false) =>
		(await cache.get(URL, { waitForFresh }))?.endpoints.map(endpoint => endpoint.provider_name);
	return { cache, clock, providers, calls: () => calls };
}

describe("StatsCache", () => {
	test("serves a fresh entry without refetching and a stale one while it refreshes in the background", async () => {
		const { clock, providers, calls } = harness(body("alibaba"), body("baseten"));
		expect(await providers()).toEqual(["alibaba"]);

		clock.now += STATS_TTL_MS - 1;
		expect(await providers()).toEqual(["alibaba"]);
		expect(calls()).toBe(1);

		clock.now += 1;
		expect(await providers()).toEqual(["alibaba"]);
		expect(await providers(true)).toEqual(["baseten"]);
		expect(calls()).toBe(2);
	});

	test("shares one fetch between concurrent callers", async () => {
		const { cache, calls } = harness(body("wafer"));
		const [first, second] = await Promise.all([cache.get(URL), cache.get(URL)]);
		expect(first).toBe(second);
		expect(calls()).toBe(1);
	});

	test("after a failure keeps the last good stats and waits before fetching again", async () => {
		const { clock, providers, calls } = harness(body("novita"), new Error("offline"), body("azure"));
		expect(await providers()).toEqual(["novita"]);

		clock.now += STATS_TTL_MS;
		expect(await providers(true)).toEqual(["novita"]);
		expect(calls()).toBe(2);

		clock.now += RETRY_AFTER_FAILURE_MS - 1;
		expect(await providers(true)).toEqual(["novita"]);
		expect(calls()).toBe(2);

		clock.now += 1;
		expect(await providers(true)).toEqual(["azure"]);
		expect(calls()).toBe(3);
	});

	test("resolves to undefined without stats and treats an unknown model as having no providers", async () => {
		const failing = harness(new Response("boom", { status: 500 }));
		expect(await failing.cache.get(URL)).toBeUndefined();

		const unknown = harness(new Response("not found", { status: 404 }));
		expect(await unknown.providers()).toEqual([]);
		expect(await unknown.providers()).toEqual([]);
		expect(unknown.calls()).toBe(1);
	});
});
