import type { Component } from "@oh-my-pi/pi-tui";
import { isFirstParty, type RankedProvider } from "./ranking.ts";

/** What `/fastcel` shows: a model's providers, fastest first, and notes under them. */
export interface RankingReport {
	modelId: string;
	/** When the stats were fetched, in milliseconds since the epoch. */
	fetchedAt: number;
	ranking: readonly RankedProvider[];
	/** Who served the last reply, a pin from the config, a model with a single provider. */
	notes: readonly string[];
}

/** The part of OMP's theme the panel draws with. */
export interface PanelTheme {
	fg(color: "accent" | "muted" | "dim" | "warning", text: string): string;
	bold(text: string): string;
}

const INDENT = "  ";
const GAP = "  ";
const BAR_CELLS = 10;
const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
/** Optional columns, in the order they give way when the terminal is too narrow. */
const DROPPABLE: readonly ColumnId[] = ["bar", "firstToken", "uptime", "note"];
const PLAIN_THEME: PanelTheme = { fg: (_color, text) => text, bold: text => text };

type ColumnId = "rank" | "provider" | "speed" | "bar" | "firstToken" | "uptime" | "note";
type CellStyle = "leader" | "demoted" | "normal";

interface Column {
	id: ColumnId;
	head: string;
	align: "left" | "right";
	cells: string[];
}

/**
 * `/fastcel` in the interactive TUI: a ranked table of the model's providers with a bar for each one's speed,
 * which closes on any key. Tern draws the same rows as a plain terminal.
 */
export class RankingPanel implements Component {
	readonly #report: RankingReport;
	readonly #theme: PanelTheme;
	readonly #close: () => void;
	readonly #now: number;
	#rows: { width: number; lines: string[] } | undefined;

	constructor(report: RankingReport, theme: PanelTheme, close: () => void, now = Date.now()) {
		this.#report = report;
		this.#theme = theme;
		this.#close = close;
		this.#now = now;
	}

	handleInput(): void {
		this.#close();
	}

	invalidate(): void {
		this.#rows = undefined;
	}

	render(width: number): string[] {
		if (this.#rows?.width !== width) {
			this.#rows = { width, lines: reportLines(this.#report, this.#theme, width, this.#now, true) };
		}
		return this.#rows.lines;
	}
}

/** The report as plain text, for clients without the interactive TUI. */
export function plainReport(report: RankingReport, now = Date.now()): string {
	return reportLines(report, PLAIN_THEME, 100, now, false).join("\n");
}

function reportLines(report: RankingReport, theme: PanelTheme, width: number, now: number, hint: boolean): string[] {
	const { modelId, ranking } = report;
	const styles: CellStyle[] = ranking.map((entry, index) =>
		entry.demotion ? "demoted" : index === 0 ? "leader" : "normal",
	);
	const maxTps = Math.max(0, ...ranking.map(entry => entry.tps ?? 0));
	let columns: Column[] = [
		{ id: "rank", head: "#", align: "right", cells: ranking.map((_, index) => String(index + 1)) },
		{ id: "provider", head: "provider", align: "left", cells: ranking.map(entry => entry.provider) },
		{ id: "speed", head: "speed", align: "right", cells: ranking.map(entry => speedText(entry.tps)) },
		{ id: "bar", head: "", align: "left", cells: ranking.map(entry => speedBar(entry.tps, maxTps)) },
		{ id: "firstToken", head: "first token", align: "right", cells: ranking.map(entry => firstTokenText(entry.ttftMs)) },
		{ id: "uptime", head: "uptime", align: "right", cells: ranking.map(entry => uptimeText(entry.uptime15m)) },
		{ id: "note", head: "", align: "left", cells: ranking.map(entry => noteText(entry, modelId)) },
	];
	let widths = columns.map(columnWidth);
	for (const id of DROPPABLE) {
		if (tableWidth(widths) <= width) break;
		const index = columns.findIndex(column => column.id === id);
		columns = columns.filter((_, at) => at !== index);
		widths = widths.filter((_, at) => at !== index);
	}
	const providerAt = columns.findIndex(column => column.id === "provider");
	const overflow = tableWidth(widths) - width;
	if (overflow > 0 && providerAt >= 0) widths[providerAt] = Math.max(4, (widths[providerAt] ?? 0) - overflow);

	const muted = (text: string) => theme.fg("muted", text);
	const textWidth = Math.max(1, width - INDENT.length);
	const title = fit(modelId, Math.max(1, textWidth - "fastcel".length - GAP.length), "left").trimEnd();
	const subtitle = `fastest first · median over the last hour · updated ${ageText(report.fetchedAt, now)}`;
	const lines = [
		"",
		`${INDENT}${theme.bold(theme.fg("accent", "fastcel"))}${GAP}${theme.bold(title)}`,
		...wrap(subtitle, textWidth).map(line => `${INDENT}${muted(line)}`),
		"",
		`${INDENT}${muted(columns.map((column, at) => fit(column.head, widths[at] ?? 0, column.align)).join(GAP).trimEnd())}`,
		`${INDENT}${muted("─".repeat(Math.max(0, tableWidth(widths) - INDENT.length)))}`,
	];
	const last = columns.length - 1;
	for (const [row, style] of styles.entries()) {
		const cells = columns.map((column, at) => {
			const cell = fit(column.cells[row] ?? "", widths[at] ?? 0, column.align);
			return styleCell(theme, column.id, style, at === last ? cell.trimEnd() : cell);
		});
		lines.push(`${INDENT}${cells.join(GAP).trimEnd()}`);
	}
	if (report.notes.length > 0) {
		lines.push("", ...report.notes.flatMap(note => wrap(note, textWidth)).map(line => `${INDENT}${line}`));
	}
	if (hint) lines.push("", `${INDENT}${theme.fg("dim", fit("press any key to close", textWidth, "left").trimEnd())}`);
	return lines;
}

/** Word-wrap one-cell-per-character text to `width`, cutting words longer than a line. */
function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line);
			line = "";
		}
		line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	return lines.map(entry => fit(entry, width, "left").trimEnd());
}

function styleCell(theme: PanelTheme, column: ColumnId, style: CellStyle, cell: string): string {
	if (column === "note") return style === "demoted" ? theme.fg("warning", cell) : theme.fg("muted", cell);
	if (style === "demoted" || column === "rank") return theme.fg("muted", cell);
	if (column === "bar") return theme.fg("accent", cell);
	if (style === "leader" && column === "provider") return theme.bold(theme.fg("accent", cell));
	if (style === "leader" && column === "speed") return theme.fg("accent", cell);
	return column === "firstToken" || column === "uptime" ? theme.fg("muted", cell) : cell;
}

function columnWidth(column: Column): number {
	return Math.max(column.head.length, ...column.cells.map(cell => cell.length));
}

function tableWidth(widths: readonly number[]): number {
	return INDENT.length + widths.reduce((sum, width) => sum + width, 0) + GAP.length * Math.max(0, widths.length - 1);
}

/** Pad or cut `text` to exactly `width` cells. Every character the panel draws is one cell wide. */
function fit(text: string, width: number, align: "left" | "right"): string {
	if (text.length > width) return width > 1 ? `${text.slice(0, width - 1)}…` : text.slice(0, width);
	return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function speedBar(tps: number | undefined, maxTps: number): string {
	if (tps === undefined || maxTps <= 0) return "";
	const eighths = Math.round((tps / maxTps) * BAR_CELLS * 8);
	return "█".repeat(Math.floor(eighths / 8)) + (PARTIAL_BLOCKS[eighths % 8] ?? "");
}

function speedText(tps: number | undefined): string {
	return tps === undefined ? "no data" : `${Math.round(tps)} tok/s`;
}

function firstTokenText(ms: number | undefined): string {
	if (ms === undefined) return "–";
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function uptimeText(percent: number | undefined): string {
	if (percent === undefined) return "–";
	return percent >= 99.95 ? "100%" : `${percent.toFixed(1)}%`;
}

function noteText(entry: RankedProvider, modelId: string): string {
	return entry.demotion ?? (isFirstParty(entry.provider, modelId) ? "first-party" : "");
}

function ageText(fetchedAt: number, now: number): string {
	const minutes = Math.floor((now - fetchedAt) / 60_000);
	return minutes < 1 ? "just now" : `${minutes} min ago`;
}
