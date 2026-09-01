// Quorima — Dashboard KPI feed writer
// Schrijft dashboard/data/kpi-overview.json (gitignored, live) zodat het
// management-dashboard de Vastgoed-kaart uit échte Twinfield-data rendert
// i.p.v. de statische mock. Zelfde patroon als de gitignored invoice-feed:
// alleen de .example-versie staat in de (publieke) repo, de live cijfers niet.

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { VastgoedFlash } from "../types.js";

export interface DashboardFeed {
  schema: "quorima.kpi-overview.v1";
  generated_at: string;
  as_of: string;
  source: string;
  twinfield_live: boolean;
  connectors_live: number;
  connectors_total: number;
  vastgoed: {
    dscr: {
      value: number;
      status: string;
      noi12m: number;
      debtService12m: number;
      /** rente op externe schuld — zit in debtService12m */
      interest12m: number;
      /** intercompany r/c-rente — apart, telt NIET mee in debtService12m */
      interestIntercompany12m: number;
      principal12m: number;
    };
    noi: {
      monthly: number;
      status: string;
      budgetEur: number | null;
      varianceVsBudget: number | null;
    };
    refi: {
      wacc: number;
      /** null = repricing-datum onbekend (leningadministratie nog niet geladen) */
      earliestRepricingMonths: number | null;
      totalDebt: number;
      status: string;
    };
  };
}

export interface BuildFeedOptions {
  generatedAt: string;
  /**
   * Kwam deze feed uit een geslaagde Twinfield-call? De caller weet dat — hij
   * heeft de adapter net gebruikt. Nooit hardcoden: het `live`-label op het
   * dashboard is een bewering over de bron, geen constante.
   */
  live: boolean;
}

export function buildDashboardFeed(
  flash: VastgoedFlash,
  opts: BuildFeedOptions,
): DashboardFeed {
  // JSON kan geen Infinity bevatten; onbekende repricing → null (front-end
  // toont dan "repricing-datum onbekend", net als de markdown-renderer).
  const repricing = Number.isFinite(flash.refi.earliestRepricingMonths)
    ? flash.refi.earliestRepricingMonths
    : null;

  return {
    schema: "quorima.kpi-overview.v1",
    generated_at: opts.generatedAt,
    as_of: flash.asOf,
    source: opts.live
      ? "Quorima KPI engine v0.1 · Twinfield live"
      : "Quorima KPI engine v0.1 · mock",
    twinfield_live: opts.live,
    connectors_live: opts.live ? 1 : 0,
    connectors_total: 5,
    vastgoed: {
      dscr: {
        value: flash.dscr.value,
        status: flash.dscr.status,
        noi12m: flash.dscr.noi12m,
        debtService12m: flash.dscr.debtService12m,
        interest12m: flash.dscr.interest12m,
        interestIntercompany12m: flash.dscr.interestIntercompany12m,
        principal12m: flash.dscr.principal12m,
      },
      noi: {
        monthly: flash.noi.monthly,
        status: flash.noi.status,
        budgetEur: flash.noi.budgetEur,
        varianceVsBudget: flash.noi.varianceVsBudget,
      },
      refi: {
        wacc: flash.refi.wacc,
        earliestRepricingMonths: repricing,
        totalDebt: flash.refi.totalDebt,
        status: flash.refi.status,
      },
    },
  };
}

/** Schrijft de feed naar `<dataDir>/kpi-overview.json` en geeft het pad terug. */
export async function writeDashboardFeed(
  flash: VastgoedFlash,
  opts: { dataDir: string; generatedAt: string; live: boolean },
): Promise<string> {
  const feed = buildDashboardFeed(flash, { generatedAt: opts.generatedAt, live: opts.live });
  const path = resolve(opts.dataDir, "kpi-overview.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(feed, null, 2) + "\n", "utf-8");
  return path;
}
