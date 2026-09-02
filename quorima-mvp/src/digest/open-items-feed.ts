// Quorima — Open-items feed writer (crediteuren + debiteuren)
// Schrijft dashboard/data/open-items.json (gitignored, live) met de openstaande
// posten per relatie uit Twinfield, voor alle administraties. Vervangt de oude
// Basecone/Gmail-factuurfeed als bron voor de dashboard-sectie "Openstaande posten".
// Zelfde patroon als de andere feeds: alleen de .example staat in de publieke repo.

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Entity, OpenItem } from "../types.js";

const SHORT: Record<string, string> = {
  "sirrapa-vastgoed": "SVG",
  "sirrapa-ict": "ICT",
  "sirrapa-holding": "SGH",
  // SPG boekt op Xero en komt (nog) niet uit de Twinfield-adapter, maar staat
  // hier zodat de code niet stilletjes de ruwe entity-id gaat tonen zodra die
  // connector wel wordt aangesloten.
  "sirrapa-property-group": "SPG",
};

/**
 * Twinfield office per entiteit, uit dezelfde env-variabelen als de adapter.
 *
 * Eerder werd de office uit de eerste openstaande post van die entiteit
 * gehaald, met "" als terugval. Een entiteit zonder openstaande posten kreeg
 * dan een lege office-code op het dashboard — precies op het moment dat er
 * niets te zien is, verdween ook het label.
 */
function officeFor(entityId: string): string {
  const byId: Record<string, string | undefined> = {
    "sirrapa-vastgoed": process.env.TWINFIELD_OFFICE_VASTGOED ?? "21007",
    "sirrapa-ict": process.env.TWINFIELD_OFFICE_ICT ?? "21005",
    "sirrapa-holding": process.env.TWINFIELD_OFFICE_HOLDING ?? "21006",
  };
  return byId[entityId] ?? "";
}

interface FeedRow {
  entity: string; // korte code (SVG/ICT/SGH)
  entityName: string;
  office: string;
  relation: string;
  amount_eur: number;
  /** alleen op prepayments-rijen: payable = vooruitbetaald, receivable = vooruitontvangen */
  side?: "payable" | "receivable";
}

export interface OpenItemsFeed {
  schema: "quorima.open-items.v1";
  generated_at: string;
  as_of: string;
  source: string;
  totals: {
    payable_eur: number;
    receivable_eur: number;
    payable_count: number;
    receivable_count: number;
    prepaid_payable_eur: number;
    prepaid_receivable_eur: number;
    prepaid_count: number;
  };
  by_entity: Array<{
    entity: string;
    entityName: string;
    office: string;
    payable_eur: number;
    receivable_eur: number;
  }>;
  payables: FeedRow[];
  receivables: FeedRow[];
  /** vooruitbetaald aan crediteuren + vooruitontvangen van debiteuren */
  prepayments: FeedRow[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const shortFor = (id: string): string => SHORT[id] ?? id;

export function buildOpenItemsFeed(
  entities: Entity[],
  items: OpenItem[],
  opts: { generatedAt: string; asOf: string },
): OpenItemsFeed {
  const nameById = new Map(entities.map((e) => [e.id, e.legalName]));
  const toRow = (i: OpenItem): FeedRow => ({
    entity: shortFor(i.entityId),
    entityName: nameById.get(i.entityId) ?? i.entityId,
    office: i.office,
    relation: i.relationName,
    amount_eur: r2(i.amountEur),
  });
  const byAmount = (a: FeedRow, b: FeedRow): number => b.amount_eur - a.amount_eur;

  const open = items.filter((i) => i.kind === "open");
  const prepaid = items.filter((i) => i.kind === "prepaid");
  const sumItems = (xs: OpenItem[]): number => r2(xs.reduce((t, i) => t + i.amountEur, 0));

  const payables = open.filter((i) => i.side === "payable").map(toRow).sort(byAmount);
  const receivables = open.filter((i) => i.side === "receivable").map(toRow).sort(byAmount);
  const prepayments = prepaid
    .map((i) => ({ ...toRow(i), side: i.side }))
    .sort(byAmount);

  const by_entity = entities.map((e) => {
    const ap = open.filter((i) => i.entityId === e.id && i.side === "payable");
    const ar = open.filter((i) => i.entityId === e.id && i.side === "receivable");
    return {
      entity: shortFor(e.id),
      entityName: e.legalName,
      // Uit de vaste mapping, niet uit de eerste post die we toevallig zagen.
      office: items.find((i) => i.entityId === e.id)?.office ?? officeFor(e.id),
      payable_eur: sumItems(ap),
      receivable_eur: sumItems(ar),
    };
  });

  return {
    schema: "quorima.open-items.v1",
    generated_at: opts.generatedAt,
    as_of: opts.asOf,
    source: "Twinfield · grootboek (crediteuren 1700 / debiteuren 1300), netto per relatie",
    totals: {
      payable_eur: sumItems(open.filter((i) => i.side === "payable")),
      receivable_eur: sumItems(open.filter((i) => i.side === "receivable")),
      payable_count: payables.length,
      receivable_count: receivables.length,
      prepaid_payable_eur: sumItems(prepaid.filter((i) => i.side === "payable")),
      prepaid_receivable_eur: sumItems(prepaid.filter((i) => i.side === "receivable")),
      prepaid_count: prepayments.length,
    },
    by_entity,
    payables,
    receivables,
    prepayments,
  };
}

export async function writeOpenItemsFeed(
  entities: Entity[],
  items: OpenItem[],
  opts: { dataDir: string; generatedAt: string; asOf: string },
): Promise<string> {
  const feed = buildOpenItemsFeed(entities, items, opts);
  const path = resolve(opts.dataDir, "open-items.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(feed, null, 2) + "\n", "utf-8");
  return path;
}
