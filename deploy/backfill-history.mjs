#!/usr/bin/env node
// Quorima — eenmalige backfill van de KPI-runhistorie
//
// Reconstrueert historie uit de bestaande flash-digests (output/flash-*.md).
// Die zijn door een LLM geschreven, dus dit is GEEN gelijkwaardige bron: de
// getallen kunnen afgerond of anders geformuleerd zijn dan wat de KPI-engine
// berekende. Regels krijgen daarom `source: "backfill-digest"` en bevatten
// alleen DSCR en WACC — de twee velden die in vrijwel elke digest consistent
// voorkomen. Een echte run voor dezelfde datum verdringt ze bij het lezen.
//
// Draai dit één keer; daarna houdt daily-flash de historie zelf bij.
//
//   node deploy/backfill-history.mjs [--output <dir>] [--data <dir>] [--dry-run]

import { readFile, readdir, appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes("--dry-run");

const here = dirname(new URL(import.meta.url).pathname);
const outputDir = resolve(arg("--output", join(here, "../quorima-mvp/output")));
const dataDir = resolve(arg("--data", join(here, "../dashboard/data")));
const historyPath = join(dataDir, "kpi-history.jsonl");

// "DSCR van -0.095", "**DSCR:** 0.179", "DSCR is 0,18" → eerste getal erna.
const DSCR_RE = /DSCR[^0-9+-]{0,25}(-?[0-9]+[.,][0-9]+)/i;
const WACC_RE = /WACC[^0-9]{0,15}([0-9]+[.,][0-9]+)\s*%/i;

const num = (s) => {
  const n = Number(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

async function existingDates() {
  try {
    const raw = await readFile(historyPath, "utf-8");
    const dates = new Set();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.as_of) dates.add(r.as_of);
      } catch { /* stille overslag, zoals readHistory */ }
    }
    return dates;
  } catch {
    return new Set();
  }
}

const files = (await readdir(outputDir))
  .filter((f) => /^flash-\d{4}-\d{2}-\d{2}\.md$/.test(f))
  .sort();

const already = await existingDates();
const records = [];
const skipped = [];

for (const file of files) {
  const asOf = file.slice("flash-".length, -".md".length);
  if (already.has(asOf)) { skipped.push([file, "staat al in de historie"]); continue; }

  const text = await readFile(join(outputDir, file), "utf-8");
  const dscr = num(text.match(DSCR_RE)?.[1]);
  const waccPct = num(text.match(WACC_RE)?.[1]);

  if (dscr == null) { skipped.push([file, "geen DSCR gevonden"]); continue; }

  records.push({
    as_of: asOf,
    // Geen echte generated_at beschikbaar; de datum is wat we weten.
    generated_at: `${asOf}T00:00:00.000Z`,
    source: "backfill-digest",
    dscr,
    wacc: waccPct == null ? null : Math.round((waccPct / 100) * 10000) / 10000,
    note: "gereconstrueerd uit de LLM-digest; afronding kan afwijken van de KPI-engine",
  });
}

records.sort((a, b) => a.as_of.localeCompare(b.as_of));

console.log(`» ${files.length} digests gevonden in ${outputDir}`);
console.log(`  ${records.length} te backfillen · ${skipped.length} overgeslagen`);
for (const [f, why] of skipped) console.log(`    - ${f}: ${why}`);
if (records.length) {
  const first = records[0], last = records[records.length - 1];
  console.log(`  bereik: ${first.as_of} (DSCR ${first.dscr}) → ${last.as_of} (DSCR ${last.dscr})`);
}

if (DRY) {
  console.log("  --dry-run: niets geschreven");
} else if (records.length) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(historyPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  console.log(`  geschreven: ${historyPath}`);
}
