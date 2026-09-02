import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOpenItemsFeed } from "./open-items-feed.js";
import type { Entity, OpenItem } from "../types.js";

const ent = (id: string, legalName: string): Entity => ({
  id: id as Entity["id"],
  legalName,
  country: "NL",
  currency: "EUR",
  gaap: "nl-gaap",
});

const item = (over: Partial<OpenItem> & Pick<OpenItem, "entityId">): OpenItem => ({
  office: "21007",
  relationName: "Leverancier",
  amountEur: 100,
  side: "payable",
  kind: "open",
  ...over,
} as OpenItem);

const opts = { generatedAt: "2026-09-02T06:00:00.000Z", asOf: "2026-09-02" };

test("een entiteit zonder openstaande posten houdt zijn office-code", () => {
  // Eerder kwam de office uit de eerste post van die entiteit; zonder posten
  // werd het een lege string en verdween het label van het dashboard.
  const feed = buildOpenItemsFeed(
    [ent("sirrapa-vastgoed", "Sirrapa Vastgoed B.V."), ent("sirrapa-ict", "Sirrapa (ICT) B.V.")],
    [item({ entityId: "sirrapa-vastgoed", office: "21007" })],
    opts,
  );
  const ict = feed.by_entity.find((e) => e.entity === "ICT");
  assert.ok(ict);
  assert.equal(ict.office, "21005", "vaste mapping, niet leeg");
  assert.equal(ict.payable_eur, 0);
});

test("entiteitscodes worden afgekort, ook SPG", () => {
  const feed = buildOpenItemsFeed(
    [
      ent("sirrapa-vastgoed", "Sirrapa Vastgoed B.V."),
      ent("sirrapa-property-group", "Sirrapa Property Group Ltd"),
    ],
    [],
    opts,
  );
  assert.deepEqual(feed.by_entity.map((e) => e.entity).sort(), ["SPG", "SVG"]);
});

test("een onbekende entiteit valt terug op de ruwe id in plaats van te crashen", () => {
  const feed = buildOpenItemsFeed([ent("iets-nieuws", "Nieuwe B.V.")], [], opts);
  assert.equal(feed.by_entity[0]?.entity, "iets-nieuws");
});

test("totalen splitsen crediteuren, debiteuren en vooruitbetaald", () => {
  const feed = buildOpenItemsFeed(
    [ent("sirrapa-vastgoed", "Sirrapa Vastgoed B.V.")],
    [
      item({ entityId: "sirrapa-vastgoed", amountEur: 100, side: "payable" }),
      item({ entityId: "sirrapa-vastgoed", amountEur: 250, side: "payable" }),
      item({ entityId: "sirrapa-vastgoed", amountEur: 400, side: "receivable" }),
      item({ entityId: "sirrapa-vastgoed", amountEur: 50, side: "payable", kind: "prepaid" }),
    ],
    opts,
  );
  assert.equal(feed.totals.payable_eur, 350);
  assert.equal(feed.totals.receivable_eur, 400);
  assert.equal(feed.totals.payable_count, 2);
  assert.equal(feed.totals.prepaid_payable_eur, 50);
  assert.equal(feed.totals.prepaid_count, 1);
  assert.equal(feed.payables.length, 2, "prepaid hoort niet bij de openstaande posten");
});

test("posten staan gesorteerd op bedrag, grootste eerst", () => {
  const feed = buildOpenItemsFeed(
    [ent("sirrapa-vastgoed", "Sirrapa Vastgoed B.V.")],
    [
      item({ entityId: "sirrapa-vastgoed", amountEur: 100, relationName: "klein" }),
      item({ entityId: "sirrapa-vastgoed", amountEur: 900, relationName: "groot" }),
      item({ entityId: "sirrapa-vastgoed", amountEur: 400, relationName: "midden" }),
    ],
    opts,
  );
  assert.deepEqual(feed.payables.map((p) => p.relation), ["groot", "midden", "klein"]);
});

test("bedragen worden op twee decimalen afgerond", () => {
  const feed = buildOpenItemsFeed(
    [ent("sirrapa-vastgoed", "Sirrapa Vastgoed B.V.")],
    [item({ entityId: "sirrapa-vastgoed", amountEur: 100.005 })],
    opts,
  );
  assert.equal(feed.payables[0]?.amount_eur, 100.01);
});
