#!/usr/bin/env node
// Quorima — Daily flash CLI entrypoint
//
// Usage:
//   npm run flash              → real Twinfield + Claude Opus
//   npm run flash:mock         → mock adapter + Claude Opus
//   npm run flash:dry-run      → mock adapter + deterministic renderer (no LLM call)
//
// Exit codes: 0 ok · 2 escalation fired (for cron-monitoring)

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AccountingPort } from "../ports/accounting.js";
import { MockAccountingPort } from "../adapters/mock/adapter.js";
import { computeDSCR, computeNOI, computeRefiRunway } from "../domain/kpi.js";
import { evaluateVastgoedEscalations } from "../domain/escalation.js";
import { CFOAgent } from "../agents/cfo.js";
import { renderDeterministicFlash } from "../digest/render.js";
import type { Period, VastgoedFlash } from "../types.js";

interface CLIArgs {
  mock: boolean;
  noLlm: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CLIArgs {
  return {
    mock: argv.includes("--mock"),
    noLlm: argv.includes("--no-llm"),
    quiet: argv.includes("--quiet"),
  };
}

async function getAdapter(args: CLIArgs): Promise<AccountingPort> {
  if (args.mock) {
    return new MockAccountingPort();
  }
  // Production: lazily import the Twinfield adapter so mock-only runs
  // don't pull in the SOAP dependency.
  const { TwinfieldAccountingPort } = await import("../adapters/twinfield/adapter.js");
  return new TwinfieldAccountingPort({
    clientId: requireEnv("TWINFIELD_CLIENT_ID"),
    clientSecret: requireEnv("TWINFIELD_CLIENT_SECRET"),
    redirectUri: requireEnv("TWINFIELD_REDIRECT_URI"),
    tokenStorePath: process.env.TWINFIELD_TOKEN_STORE ?? resolve(".twinfield-tokens.json"),
  });
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (msg: string): void => {
    if (!args.quiet) console.log(msg);
  };

  log("» Quorima daily flash starting…");
  log(`  mode: ${args.mock ? "MOCK" : "PRODUCTION"} · llm: ${args.noLlm ? "OFF" : "ON"}`);

  // 1. Get adapter + entity
  const adapter = await getAdapter(args);
  const entities = await adapter.listEntities();
  const vastgoed = entities.find((e) => e.id === "sirrapa-vastgoed");
  if (!vastgoed) {
    console.error("Sirrapa Vastgoed entity not found in connected accounting");
    process.exit(1);
  }
  log(`  entity: ${vastgoed.legalName}`);

  // 2. Pull data
  const today = new Date();
  const period: Period = { year: today.getFullYear(), period: "FY" };

  const [pnl, loans, recentTx] = await Promise.all([
    adapter.getPnL(vastgoed.id, period),
    adapter.deriveLoanRegister(vastgoed.id),
    adapter.listTransactions(vastgoed.id, {
      from: yesterdayISO(),
      to: todayISO(),
    }),
  ]);
  log(`  data fetched: P&L (${pnl.lines.length} lines), loans (${loans.length}), recent tx (${recentTx.length})`);

  // 3. Compute KPIs
  const budgetEnv = process.env.NOI_BUDGET_EUR_MONTHLY;
  const budgetEur = budgetEnv ? Number(budgetEnv) : null;

  const dscr = computeDSCR(pnl, loans);
  const noi = computeNOI(pnl, budgetEur);
  const refi = computeRefiRunway(loans, today, {
    waccRedPct: numberFromEnv("WACC_RED_PCT", 7),
    refiRedMonths: numberFromEnv("REFI_RUNWAY_RED_MONTHS", 6),
  });

  log(`  KPIs computed:`);
  log(`    DSCR ${dscr.value} (${dscr.status})`);
  log(`    NOI €${noi.monthly.toFixed(0)}/mo (${noi.status})`);
  // Zonder leningadministratie is er geen repricing-datum en is de runway
  // Infinity; `toFixed` maakt daar "Infinitymo" van. Net als de feed (null) en
  // de escalatie-tekst tonen we hier expliciet dat het onbekend is.
  const runway = Number.isFinite(refi.earliestRepricingMonths)
    ? `${refi.earliestRepricingMonths.toFixed(1)}mo`
    : "onbekend";
  log(`    refi WACC ${(refi.wacc * 100).toFixed(2)}% · runway ${runway} (${refi.status})`);

  // 4. Evaluate escalations — met de runhistorie erbij, zodat de regels die
  //    perioden vergelijken (covenant, NOI YoY) echt kunnen vuren. Ontbreekt de
  //    historie, dan blijven ze uit: liever niet escaleren dan op een aanname.
  const dataDir = process.env.DASHBOARD_DATA_DIR ?? resolve("../dashboard/data");
  const { readHistory, dscrBelowOneForConsecutiveQuarters, noiYoYChange } =
    await import("../digest/history.js");
  // Bij een mock-run bewust géén echte historie: mock-cijfers vergelijken met
  // live waarnemingen levert onzin op.
  const history = args.mock ? [] : await readHistory(dataDir);
  const twoQuartersBelowOne = dscrBelowOneForConsecutiveQuarters(history, 2, today);
  const yoy = noiYoYChange(history, today);
  log(
    `  historie: ${history.length} runs` +
      (history.length ? ` (${history[0]?.as_of} → ${history[history.length - 1]?.as_of})` : "") +
      ` · DSCR <1 twee kwartalen op rij: ${twoQuartersBelowOne ? "ja" : "nee"}` +
      (yoy ? ` · NOI YoY ${yoy.changePct.toFixed(1)}%` : " · NOI YoY nog niet vergelijkbaar"),
  );

  const escalations = evaluateVastgoedEscalations(dscr, noi, refi, {
    recipients: {
      cfo: [process.env.DIGEST_RECIPIENT ?? "armand.parris@sirrapagroup.com"],
      ceo: [process.env.DIGEST_RECIPIENT ?? "armand.parris@sirrapagroup.com"],
      coo: [process.env.DIGEST_RECIPIENT ?? "armand.parris@sirrapagroup.com"],
    },
    dscrBelowOneForTwoQuartersInRow: twoQuartersBelowOne,
    noiYoYChangePct: yoy?.changePct ?? null,
  });
  log(`  escalations: ${escalations.length} (${escalations.map((e) => e.level).join(", ") || "none"})`);

  // 4b. Is dit nieuws? Tussen 17 juni en 1 september vuurden 39 van de 39
  //     geslaagde runs een identieke kritieke escalatie. Daardoor viel niet op
  //     dat er 16 keer op rij een storingsmelding tussendoor kwam. De toestand
  //     blijft elke dag in de digest staan, maar de Telegram-melding wordt
  //     alleen luid als er écht iets verandert.
  const { escalationFingerprint } = await import("../domain/escalation.js");
  const fingerprint = escalationFingerprint(escalations, dscr, noi, refi);
  const previous = [...history].reverse().find((h) => h.as_of !== todayISO() && h.fingerprint);
  const unchanged = previous?.fingerprint === fingerprint;
  // `since` rolt door zolang de toestand gelijk blijft; bij een wijziging
  // begint de teller vandaag opnieuw.
  const since = unchanged ? (previous?.since ?? previous?.as_of ?? todayISO()) : todayISO();
  if (unchanged) {
    const days = Math.round((Date.parse(todayISO()) - Date.parse(since)) / 86400000);
    log(`[quorima] escalatie-status: ongewijzigd sinds ${since} (${days} dagen)`);
  } else if (previous) {
    log(`[quorima] escalatie-status: GEWIJZIGD t.o.v. ${previous.as_of}`);
  } else {
    log("[quorima] escalatie-status: geen vergelijkbare vorige run");
  }

  // 5. Build the canonical flash payload
  const flash: VastgoedFlash = {
    asOf: todayISO(),
    entity: vastgoed,
    dscr,
    noi,
    refi,
    recentMaterialTx: recentTx,
    escalations,
  };

  // 6. Update de dashboard-feeds — data vóór narratief.
  //
  //     Bewust vóór het renderen van de digest: de cijfers zijn op dit punt
  //     al binnen en berekend, dus een storing in de LLM-laag (rate limit,
  //     lege credits, netwerk) mag het dashboard nooit meer op een oude
  //     stand laten staan. Aug 2026 ging dat 16 runs lang mis.
  //
  //     Alleen bij live runs — nooit de gitignored feeds overschrijven met
  //     mock/dry-run data.
  if (!args.mock) {
    const generatedAt = new Date().toISOString();

    const { writeDashboardFeed } = await import("../digest/dashboard-feed.js");
    const feedPath = await writeDashboardFeed(flash, {
      dataDir,
      generatedAt,
      // Twinfield is aantoonbaar live: de P&L/leningen hierboven kwamen uit
      // een geslaagde adapter-call. Geen hardcoded literal meer.
      live: true,
    });
    log(`  dashboard feed: ${feedPath}`);

    // Openstaande posten crediteuren + debiteuren over alle administraties.
    const { writeOpenItemsFeed } = await import("../digest/open-items-feed.js");
    const openItems = [];
    for (const e of entities) {
      try {
        openItems.push(...(await adapter.listOpenItems(e.id)));
      } catch (err) {
        log(`  ⚠ open items ${e.id}: ${(err as Error).message}`);
      }
    }
    const oiPath = await writeOpenItemsFeed(entities, openItems, {
      dataDir,
      generatedAt,
      asOf: todayISO(),
    });
    log(`  open-items feed: ${oiPath} (${openItems.length} posten)`);

    // Runhistorie: append-only, zodat KPI-regels die perioden vergelijken
    // (DSCR 2 kwartalen op rij, NOI YoY) een basis hebben. Mag de run nooit
    // laten falen — historie is waardevol, maar minder dan de dagelijkse cijfers.
    try {
      const { appendHistory, buildHistoryRecord } = await import("../digest/history.js");
      const hPath = await appendHistory(
        buildHistoryRecord(flash, generatedAt, { fingerprint, since }),
        { dataDir },
      );
      log(`  historie: ${hPath}`);
    } catch (err) {
      log(`  ⚠ historie niet weggeschreven: ${(err as Error).message}`);
    }
  }

  // 7. Render de digest (LLM of deterministisch).
  //
  //     De LLM schrijft alleen de *duiding* — de cijfers staan al vast. Valt
  //     de provider uit, dan degraderen we naar de deterministische renderer
  //     in plaats van de hele run te laten falen.
  let markdown: string;
  let digestDegraded = false;
  if (args.noLlm) {
    markdown = renderDeterministicFlash(flash);
    log("  digest rendered (deterministic)");
  } else {
    const cfo = new CFOAgent();
    log(`  calling ${cfo.provider}:${cfo.model}…`);
    try {
      const out = await cfo.writeDailyFlash(flash);
      markdown = out.markdown;
      log(`  digest rendered (LLM, ${out.usage.inputTokens ?? "?"} in / ${out.usage.outputTokens ?? "?"} out tokens)`);
    } catch (err) {
      digestDegraded = true;
      // Provider-fouten zijn vaak meerregelige JSON; platslaan tot één
      // leesbare regel die in een Telegram-melding past.
      const reason = ((err as Error).message || "onbekende fout")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      log(`  ⚠ LLM-call mislukt (${cfo.provider}:${cfo.model}) — terugval op deterministische digest`);
      log(`    ${reason}`);
      markdown =
        `> ⚠️ **Digest gedegradeerd** — de LLM-duiding is niet gelukt ` +
        `(${cfo.provider}:${cfo.model}: ${reason}).\n` +
        `> De cijfers hieronder komen ongewijzigd uit de KPI-engine en zijn wél vers.\n\n` +
        renderDeterministicFlash(flash);
    }
  }

  // 8. Persist
  const outputDir = resolve(process.env.DIGEST_OUTPUT_DIR ?? "./output");
  await mkdir(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, `flash-${todayISO()}.md`);
  await writeFile(outputPath, markdown, "utf-8");
  log(`  written: ${outputPath}`);

  // 9. Echo to stdout (so cron / pipe consumers can read it directly)
  if (!args.quiet) {
    console.log("\n────────────────────────────────────────");
    console.log(markdown);
    console.log("────────────────────────────────────────\n");
  }

  // Exit code 2 als een kritieke escalatie vuurde (cron-monitor signaal).
  // Exit code 3 als de run zelf slaagde maar de digest gedegradeerd is —
  // de cijfers staan vers op het dashboard, alleen de duiding ontbreekt.
  // Code 2 wint: een covenant-escalatie is dringender dan een missende LLM.
  if (escalations.some((e) => e.level === "critical")) {
    process.exit(2);
  }
  if (digestDegraded) {
    process.exit(3);
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function numberFromEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

main().catch((err) => {
  console.error("[quorima] daily flash failed:", err);
  process.exit(1);
});
