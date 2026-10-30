import { describe, expect, test } from "bun:test";
import { RankingPanel, type RankingReport } from "../src/panel.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const report: RankingReport = {
	modelId: "deepseek/deepseek-v4.1-flash",
	fetchedAt: 0,
	ranking: [
		{ provider: "deepseek", tps: 191, ttftMs: 1620, uptime15m: 99.9 },
		{ provider: "inference-net", tps: 141, ttftMs: 560, uptime15m: 100 },
		{ provider: "vertex", demotion: "degraded (88.1% up)" },
	],
	notes: ["Vercel has not published which provider served the last reply yet; ask again in a minute."],
};

describe("RankingPanel", () => {
	test("never draws a line wider than the terminal, giving up the speed bars and other extras first", () => {
		for (const width of [120, 60, 32]) {
			const lines = new RankingPanel(report, plainTheme, () => {}, 0).render(width);
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
			expect(lines.join("\n")).toContain("191 tok/s");
		}
		expect(new RankingPanel(report, plainTheme, () => {}, 0).render(120).join("\n")).toContain("██████████");
		expect(new RankingPanel(report, plainTheme, () => {}, 0).render(60).join("\n")).not.toContain("█");
	});
});
