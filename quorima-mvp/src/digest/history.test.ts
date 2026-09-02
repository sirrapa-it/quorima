import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HISTORY_FILENAME,
  dscrBelowOneForConsecutiveQuarters,
  noiYoYChange,
  quarterOf,
  readHistory,
  type HistoryRecord,
} from "./history.js";

const rec = (as_of: string, dscr: number | null, extra: Partial<HistoryRecord> = {}): HistoryRecord => ({
  as_of,
  generated_at: `${as_of}T08:00:00.000Z`,
  source: "run",
  dscr,
  wacc: 0.1,
  ...extra,
});

async function historyDir(lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quorima-hist-"));
  await writeFile(
    join(dir, HISTORY_FILENAME),
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    "utf-8",
  );
  return dir;
}

test("quarterOf mapt maanden op kalenderkwartalen", () => {
  assert.equal(quarterOf("2026-01-31"), "2026-Q1");
  assert.equal(quarterOf("2026-03-31"), "2026-Q1");
  assert.equal(quarterOf("2026-04-01"), "2026-Q2");
  assert.equal(quarterOf("2026-09-02"), "2026-Q3");
  assert.equal(quarterOf("2026-12-31"), "2026-Q4");
});

test("readHistory: ontbrekend bestand geeft lege lijst, geen fout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quorima-empty-"));
  assert.deepEqual(await readHistory(dir), []);
});

test("readHistory: kapotte regels worden overgeslagen, rest blijft bruikbaar", async () => {
  const dir = await historyDir([rec("2026-01-15", 0.5), "{niet: geldig json", rec("2026-02-15", 0.6)]);
  const out = await readHistory(dir);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.as_of), ["2026-01-15", "2026-02-15"]);
});

test("readHistory: laatste waarneming per dag wint", async () => {
  const dir = await historyDir([rec("2026-01-15", 0.5), rec("2026-01-15", 0.9)]);
  const out = await readHistory(dir);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.dscr, 0.9);
});

test("readHistory: een echte run verdringt een backfill, ongeacht volgorde", async () => {
  const dir = await historyDir([
    rec("2026-01-15", 0.42),
    rec("2026-01-15", 0.99, { source: "backfill-digest" }),
  ]);
  const out = await readHistory(dir);
  assert.equal(out[0]?.source, "run");
  assert.equal(out[0]?.dscr, 0.42, "backfill mag een echte meting niet overschrijven");
});

test("readHistory sorteert oplopend op datum", async () => {
  const dir = await historyDir([rec("2026-03-01", 0.3), rec("2026-01-01", 0.1), rec("2026-02-01", 0.2)]);
  const out = await readHistory(dir);
  assert.deepEqual(out.map((r) => r.as_of), ["2026-01-01", "2026-02-01", "2026-03-01"]);
});

// ─── de covenant-regel ────────────────────────────────────────────────

const today = new Date("2026-09-02T08:00:00Z"); // Q3

test("covenant: te weinig historie escaleert niet", () => {
  assert.equal(dscrBelowOneForConsecutiveQuarters([rec("2026-06-30", 0.2)], 2, today), false);
});

test("covenant: twee afgesloten kwartalen onder 1,0 vuurt", () => {
  const h = [rec("2026-03-31", 0.4), rec("2026-06-30", 0.2)];
  assert.equal(dscrBelowOneForConsecutiveQuarters(h, 2, today), true);
});

test("covenant: één kwartaal hersteld boven 1,0 vuurt niet", () => {
  const h = [rec("2026-03-31", 1.4), rec("2026-06-30", 0.2)];
  assert.equal(dscrBelowOneForConsecutiveQuarters(h, 2, today), false);
});

test("covenant: het lopende kwartaal telt niet mee", () => {
  // Alleen Q3 (lopend) is rood; Q2 ontbreekt → onvoldoende afgesloten historie.
  const h = [rec("2026-08-01", 0.1), rec("2026-09-01", 0.1)];
  assert.equal(dscrBelowOneForConsecutiveQuarters(h, 2, today), false);
});

test("covenant: per kwartaal telt de laatste waarneming", () => {
  // Q2 begint rood maar eindigt hersteld → geen twee slechte kwartalen op rij.
  const h = [rec("2026-03-31", 0.4), rec("2026-04-05", 0.3), rec("2026-06-30", 1.6)];
  assert.equal(dscrBelowOneForConsecutiveQuarters(h, 2, today), false);
});

test("covenant: negatieve DSCR telt als onder 1,0", () => {
  const h = [rec("2026-03-31", -0.1), rec("2026-06-30", -0.106)];
  assert.equal(dscrBelowOneForConsecutiveQuarters(h, 2, today), true);
});

test("covenant: records zonder DSCR worden genegeerd", () => {
  const h = [rec("2026-03-31", null), rec("2026-06-30", 0.2)];
  assert.equal(dscrBelowOneForConsecutiveQuarters(h, 2, today), false);
});

// ─── NOI year-over-year ───────────────────────────────────────────────

test("noiYoY: zonder vergelijkbaar jaar terug geeft null", () => {
  const h = [rec("2026-08-01", 0.2, { noi_12m: 1000 }), rec("2026-09-01", 0.2, { noi_12m: 900 })];
  assert.equal(noiYoYChange(h, today), null);
});

test("noiYoY: berekent de procentuele verandering", () => {
  const h = [
    rec("2025-09-01", 0.5, { noi_12m: 10000 }),
    rec("2026-09-01", 0.2, { noi_12m: 8000 }),
  ];
  const out = noiYoYChange(h, today);
  assert.ok(out);
  assert.equal(out.previous, 10000);
  assert.equal(out.current, 8000);
  assert.equal(Math.round(out.changePct), -20);
});

test("noiYoY: negatieve basis gebruikt de absolute waarde als noemer", () => {
  const h = [
    rec("2025-09-01", 0.5, { noi_12m: -5000 }),
    rec("2026-09-01", 0.2, { noi_12m: -10000 }),
  ];
  const out = noiYoYChange(h, today);
  assert.ok(out);
  assert.equal(Math.round(out.changePct), -100, "verder in de min = negatieve verandering");
});

test("noiYoY: backfill-regels tellen niet mee (alleen dscr/wacc betrouwbaar)", () => {
  const h = [
    rec("2025-09-01", 0.5, { noi_12m: 10000, source: "backfill-digest" }),
    rec("2026-09-01", 0.2, { noi_12m: 8000 }),
  ];
  assert.equal(noiYoYChange(h, today), null);
});
