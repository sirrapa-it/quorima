// Quorima — KPI-runhistorie (append-only JSONL)
//
// Elke live run legt één regel vast met de berekende KPI's. Zonder dit kan geen
// enkele KPI-regel die twee perioden vergelijkt vuren — en dat zijn er drie in
// `kpis/KPIs_per_werkmaatschappij.md`: DSCR onder 1,0 voor twee opeenvolgende
// kwartalen, NOI-uitval YoY, en de trendduiding in de digest. Tot september 2026
// werd elke run over de vorige heen geschreven, dus die regels waren
// structureel onuitvoerbaar.
//
// Append-only en per regel zelfstandig leesbaar: raakt het bestand halverwege
// beschadigd, dan blijven de eerdere regels bruikbaar.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { VastgoedFlash } from "../types.js";

export const HISTORY_FILENAME = "kpi-history.jsonl";

export interface HistoryRecord {
  as_of: string;
  generated_at: string;
  /**
   * `run` = rechtstreeks uit de KPI-engine, alle velden betrouwbaar.
   * `backfill-digest` = achteraf gereconstrueerd uit een LLM-geschreven digest;
   * alleen dscr en wacc, en die kunnen afgerond zijn. Nooit door elkaar halen.
   */
  source: "run" | "backfill-digest";
  dscr: number | null;
  dscr_status?: string;
  noi_monthly?: number | null;
  noi_12m?: number | null;
  noi_status?: string;
  wacc: number | null;
  total_debt?: number | null;
  debt_service_12m?: number | null;
  interest_intercompany_12m?: number | null;
  escalations?: string[];
  /**
   * Vingerafdruk van de escalatietoestand (welke regels vuren + de drie
   * KPI-statussen), zonder bedragen. Twee runs met dezelfde vingerafdruk zijn
   * hetzelfde nieuws.
   */
  fingerprint?: string;
  /**
   * Sinds wanneer deze toestand onveranderd is. Rolt door zolang de
   * vingerafdruk gelijk blijft, zodat je "al 39 dagen hetzelfde" kunt zien in
   * plaats van 39 losse meldingen.
   */
  since?: string;
  note?: string;
}

export function buildHistoryRecord(
  flash: VastgoedFlash,
  generatedAt: string,
  state?: { fingerprint: string; since: string },
): HistoryRecord {
  return {
    as_of: flash.asOf,
    generated_at: generatedAt,
    source: "run",
    fingerprint: state?.fingerprint,
    since: state?.since,
    dscr: flash.dscr.value,
    dscr_status: flash.dscr.status,
    noi_monthly: flash.noi.monthly,
    noi_12m: flash.dscr.noi12m,
    noi_status: flash.noi.status,
    wacc: flash.refi.wacc,
    total_debt: flash.refi.totalDebt,
    debt_service_12m: flash.dscr.debtService12m,
    interest_intercompany_12m: flash.dscr.interestIntercompany12m,
    escalations: flash.escalations.map((e) => e.level),
  };
}

/** Voegt één regel toe. Faalt nooit hard: historie mag de run niet blokkeren. */
export async function appendHistory(
  record: HistoryRecord,
  opts: { dataDir: string },
): Promise<string> {
  const path = resolve(opts.dataDir, HISTORY_FILENAME);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n", "utf-8");
  return path;
}

/**
 * Leest de historie, nieuwste laatst.
 *
 * Meerdere runs op dezelfde dag zijn normaal (handmatige run naast de cron); we
 * houden per `as_of` de laatste over. Een echte run verdringt altijd een
 * backfill-regel voor dezelfde datum, ongeacht volgorde in het bestand.
 * Onleesbare regels worden overgeslagen in plaats van de hele lees-actie te
 * laten klappen.
 */
export async function readHistory(dataDir: string): Promise<HistoryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(resolve(dataDir, HISTORY_FILENAME), "utf-8");
  } catch {
    return [];
  }

  const byDate = new Map<string, HistoryRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: HistoryRecord;
    try {
      rec = JSON.parse(line) as HistoryRecord;
    } catch {
      continue;
    }
    if (!rec.as_of) continue;
    const prev = byDate.get(rec.as_of);
    if (prev && prev.source === "run" && rec.source !== "run") continue;
    byDate.set(rec.as_of, rec);
  }

  return [...byDate.values()].sort((a, b) => a.as_of.localeCompare(b.as_of));
}

// ─── Afgeleide vragen die de escalatieregels stellen ──────────────────

/** Kalenderkwartaal van een ISO-datum, bv. "2026-Q3". */
export function quarterOf(isoDate: string): string {
  const [y, m] = isoDate.split("-");
  const q = Math.floor((Number(m) - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

/**
 * Stond de DSCR in `count` opeenvolgende, afgesloten kwartalen onder 1,0?
 *
 * De KPI-doc koppelt hier de covenant-escalatie aan. We kijken per kwartaal naar
 * de LAATSTE waarneming (de stand aan het eind van dat kwartaal) en negeren het
 * lopende kwartaal — dat is nog niet af, en daarop escaleren zou de regel elke
 * dag opnieuw laten vuren zodra één meting rood is.
 *
 * Geeft false zolang er onvoldoende historie is. Dat is bewust: liever niet
 * escaleren dan escaleren op een aanname.
 */
export function dscrBelowOneForConsecutiveQuarters(
  history: HistoryRecord[],
  count = 2,
  today = new Date(),
): boolean {
  const currentQuarter = quarterOf(today.toISOString().slice(0, 10));

  const lastByQuarter = new Map<string, HistoryRecord>();
  for (const rec of history) {
    if (rec.dscr == null) continue;
    const q = quarterOf(rec.as_of);
    if (q === currentQuarter) continue;
    lastByQuarter.set(q, rec); // history is oplopend gesorteerd → laatste wint
  }

  const quarters = [...lastByQuarter.keys()].sort();
  if (quarters.length < count) return false;

  return quarters
    .slice(-count)
    .every((q) => (lastByQuarter.get(q)?.dscr ?? Infinity) < 1.0);
}

/**
 * NOI-verandering ten opzichte van ongeveer een jaar geleden.
 *
 * Zoekt de waarneming die het dichtst bij 12 maanden terug ligt, met maximaal
 * 45 dagen speling. Buiten die marge geven we null in plaats van een
 * appels-met-peren-vergelijking.
 */
export function noiYoYChange(
  history: HistoryRecord[],
  today = new Date(),
): { current: number; previous: number; changePct: number } | null {
  const withNoi = history.filter(
    (r) => r.source === "run" && typeof r.noi_12m === "number",
  );
  if (withNoi.length < 2) return null;

  const latest = withNoi[withNoi.length - 1];
  if (!latest?.noi_12m) return null;

  const targetMs = new Date(latest.as_of).getTime() - 365 * 86400000;
  const maxDriftMs = 45 * 86400000;

  let best: HistoryRecord | null = null;
  let bestDrift = Infinity;
  for (const rec of withNoi.slice(0, -1)) {
    const drift = Math.abs(new Date(rec.as_of).getTime() - targetMs);
    if (drift < bestDrift) {
      bestDrift = drift;
      best = rec;
    }
  }
  if (!best || bestDrift > maxDriftMs || !best.noi_12m) return null;

  const previous = best.noi_12m;
  const current = latest.noi_12m;
  if (previous === 0) return null;

  return {
    current,
    previous,
    changePct: ((current - previous) / Math.abs(previous)) * 100,
  };
}
