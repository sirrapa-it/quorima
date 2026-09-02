import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePnLFromBrowseXml } from "./adapter.js";

/** Bouwt een browse-respons zoals Twinfield hem teruggeeft. */
function browseXml(rows: Array<[account: string, signed: number]>): string {
  const trs = rows
    .map(
      ([acc, val]) =>
        `<tr><td field="fin.trs.line.dim1">${acc}</td>` +
        `<td field="fin.trs.line.valuesigned">${val.toFixed(2)}</td></tr>`,
    )
    .join("");
  return `<browse>${trs}</browse>`;
}

const names = (m: Record<string, string>) => new Map(Object.entries(m));
const period = { year: 2026, period: "FY" as const };

test("omzet staat credit en wordt positief geteld", () => {
  const pnl = parsePnLFromBrowseXml(
    browseXml([["8000", -11475.35]]),
    names({ "8000": "Omzet Verhuur" }),
    "sirrapa-vastgoed",
    period,
  );
  assert.equal(pnl.totals.revenue, 11475.35);
});

test("kosten staan debet en worden positief geteld", () => {
  const pnl = parsePnLFromBrowseXml(
    browseXml([["7000", 26508.25]]),
    names({ "7000": "Inkoop goederen" }),
    "sirrapa-vastgoed",
    period,
  );
  assert.equal(pnl.totals.operatingExpenses, 26508.25);
});

test("een kostenrekening die netto CREDIT staat verlaagt de kosten", () => {
  // De kern van deze fix. Eerder maakte Math.abs() hier een positieve
  // kostenpost van, waardoor een creditnota de opex juist verhoogde.
  const pnl = parsePnLFromBrowseXml(
    browseXml([
      ["4430", 1000], // gewone onderhoudskosten
      ["4805", -250], // creditnota van de accountant, per saldo een bate
    ]),
    names({ "4430": "Onderhoudskosten panden", "4805": "Accountantskosten" }),
    "sirrapa-vastgoed",
    period,
  );
  assert.equal(pnl.totals.operatingExpenses, 750, "1000 − 250, niet 1000 + 250");
});

test("regels op dezelfde rekening worden gesaldeerd", () => {
  const pnl = parsePnLFromBrowseXml(
    browseXml([["4430", 1000], ["4430", -300], ["4430", 50]]),
    names({ "4430": "Onderhoudskosten panden" }),
    "sirrapa-vastgoed",
    period,
  );
  assert.equal(pnl.totals.operatingExpenses, 750);
});

test("rente, intercompany-rente en opex worden gescheiden", () => {
  const pnl = parsePnLFromBrowseXml(
    browseXml([
      ["4612", 60904.11],
      ["4631", 6930.58],
      ["4639", 1299.0],
      ["4430", 223.98],
    ]),
    names({
      "4612": "Rente leningen Mogelijk",
      "4631": "Rente r/c groepsmaatschappijen",
      "4639": "Rente belastingen",
      "4430": "Onderhoudskosten panden",
    }),
    "sirrapa-vastgoed",
    period,
  );
  assert.equal(pnl.totals.interestExpense, 60904.11);
  assert.equal(pnl.totals.interestExpenseIntercompany, 6930.58);
  assert.equal(
    pnl.totals.operatingExpenses,
    1299.0 + 223.98,
    "belastingrente is opex, geen schuldendienst",
  );
});

test("balansrekeningen worden overgeslagen", () => {
  const pnl = parsePnLFromBrowseXml(
    browseXml([["1300", 50000], ["8000", -1000]]),
    names({ "1300": "Debiteuren", "8000": "Omzet Verhuur" }),
    "sirrapa-vastgoed",
    period,
  );
  assert.equal(pnl.lines.length, 1);
  assert.equal(pnl.totals.revenue, 1000);
});

test("netResult trekt alle lastensoorten af, intercompany incluis", () => {
  const pnl = parsePnLFromBrowseXml(
    browseXml([
      ["8000", -100000],
      ["4430", 20000],
      ["4612", 30000],
      ["4631", 5000],
      ["4100", 10000],
      ["4900", 2000],
    ]),
    names({
      "8000": "Omzet Verhuur",
      "4430": "Onderhoudskosten panden",
      "4612": "Rente leningen Mogelijk",
      "4631": "Rente r/c groepsmaatschappijen",
      "4100": "Afschrijving gebouwen",
      "4900": "Vennootschapsbelasting",
    }),
    "sirrapa-vastgoed",
    period,
  );
  assert.equal(pnl.totals.netResult, 100000 - 20000 - 30000 - 5000 - 10000 - 2000);
});

test("een lege respons geeft nulwaarden, geen NaN", () => {
  const pnl = parsePnLFromBrowseXml("<browse></browse>", names({}), "sirrapa-vastgoed", period);
  assert.equal(pnl.totals.revenue, 0);
  assert.equal(pnl.totals.operatingExpenses, 0);
  assert.equal(pnl.totals.netResult, 0);
  assert.equal(pnl.lines.length, 0);
});

test("een rekening zonder bekende naam valt terug op de code", () => {
  const pnl = parsePnLFromBrowseXml(
    browseXml([["8000", -500]]),
    names({}),
    "sirrapa-vastgoed",
    period,
  );
  assert.equal(pnl.lines[0]?.name, "8000");
  assert.equal(pnl.totals.revenue, 500);
});

/**
 * Regressie op de echte septemberstand van office 21007. Deze totalen voeden
 * DSCR −0,106 en NOI −€792/mnd; wijzigt de parser, dan hoort dat hier te
 * botsen en niet pas op het dashboard.
 */
test("regressie: de echte 21007-cijfers komen er hetzelfde uit", () => {
  const pnl = parsePnLFromBrowseXml(
    browseXml([
      ["8000", -11475.35],
      ["8004", -22450.08],
      ["7000", 26508.25],
      ["7700", 4657.5],
      ["4745", 4278.39],
      ["4805", 2820.98],
      ["4460", 1337.8],
      ["4639", 1299.0],
      ["4653", 840.0],
      ["4755", 386.92],
      ["4840", 353.13],
      ["4459", 263.64],
      ["4650", 242.91],
      ["4430", 223.98],
      ["4750", 111.57],
      ["4677", 71.0],
      ["4382", 32.5],
      ["4658", 2.2],
      ["4898", 1.58],
      ["4612", 60904.11],
      ["4623", 5726.66],
      ["4610", 17.67],
      ["4601", 5.35],
      ["4631", 6930.58],
    ]),
    names({
      "8000": "Omzet Verhuur", "8004": "Omzet Chaletpark de Wierde",
      "7000": "Inkoop goederen", "7700": "Werkzaamheden derden",
      "4745": "Onderhoudscontracten computers/software", "4805": "Accountantskosten",
      "4460": "Onroerend-zaak belasting", "4639": "Rente belastingen",
      "4653": "Kosten lening Collin Crowdfund (44488)", "4755": "Internet en email",
      "4840": "Contributies", "4459": "Kleine aanschaffingen / investeringen",
      "4650": "Bankkosten", "4430": "Onderhoudskosten panden", "4750": "Telefoon",
      "4677": "Boetes belastingen", "4382": "Representatiekosten beperkt aftrekbaar",
      "4658": "Kosten lening Resonandina Holanda B.V. (42294)",
      "4898": "Overige algemene kosten", "4612": "Rente leningen Mogelijk",
      "4623": "Rente lening Collin Crowdfund (44488)",
      "4610": "Rente lening Resonandina Holanda B.V. (42294)",
      "4601": "Rente bank 2", "4631": "Rente r/c groepsmaatschappijen",
    }),
    "sirrapa-vastgoed",
    period,
  );
  const round2 = (n: number) => Math.round(n * 100) / 100;
  assert.equal(round2(pnl.totals.revenue), 33925.43);
  assert.equal(round2(pnl.totals.operatingExpenses), 43431.35);
  assert.equal(round2(pnl.totals.interestExpense), 66653.79);
  assert.equal(round2(pnl.totals.interestExpenseIntercompany), 6930.58);
});
