import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyPnl,
  isCumulativeRepaymentAccount,
  isCurrentPrincipalAccount,
  isIntercompanyInterestAccount,
  isLoanPrincipalAccount,
} from "./account-classify.js";

// ─── P&L-classificatie ────────────────────────────────────────────────

test("8xxx is omzet", () => {
  assert.equal(classifyPnl("8000", "Omzet Verhuur"), "revenue");
  assert.equal(classifyPnl("8004", "Omzet Chaletpark de Wierde"), "revenue");
});

test("rentekosten zijn schuldendienst, belastingrente niet", () => {
  assert.equal(classifyPnl("4612", "Rente leningen Mogelijk"), "interest");
  assert.equal(classifyPnl("4623", "Rente lening Collin Crowdfund (44488)"), "interest");
  assert.equal(classifyPnl("4601", "Rente bank 2"), "interest");
  // Belastingrente is een boete-achtige last, geen financieringslast.
  assert.equal(classifyPnl("4639", "Rente belastingen"), "opex");
});

test("intercompany-rente krijgt een eigen categorie", () => {
  // De kern van de WACC-correctie: deze rente hoort niet bij de externe schuld,
  // want de bijbehorende hoofdsom zit niet in het leningregister.
  assert.equal(classifyPnl("4631", "Rente r/c groepsmaatschappijen"), "interest-intercompany");
  assert.equal(classifyPnl("4632", "Rente rekening-courant directie"), "interest-intercompany");
});

test("afschrijving en vpb staan los van de operationele kosten", () => {
  assert.equal(classifyPnl("4100", "Afschrijving gebouwen"), "depreciation");
  assert.equal(classifyPnl("4900", "Vennootschapsbelasting"), "tax");
});

test("overige 4xxx-7xxx zijn operationele kosten", () => {
  assert.equal(classifyPnl("7000", "Inkoop goederen"), "opex");
  assert.equal(classifyPnl("4430", "Onderhoudskosten panden"), "opex");
  assert.equal(classifyPnl("4805", "Accountantskosten"), "opex");
  assert.equal(classifyPnl("4650", "Bankkosten"), "opex");
});

test("balansrekeningen tellen niet mee in de P&L", () => {
  assert.equal(classifyPnl("1300", "Debiteuren"), "ignore");
  assert.equal(classifyPnl("1700", "Crediteuren"), "ignore");
  assert.equal(classifyPnl("0500", "Eigen vermogen"), "ignore");
  assert.equal(classifyPnl("1620", "Lening Mogelijk"), "ignore");
});

test("classificatie werkt zonder naam (val terug op de code)", () => {
  assert.equal(classifyPnl("8000"), "revenue");
  assert.equal(classifyPnl("4500"), "opex");
  assert.equal(classifyPnl("1300"), "ignore");
});

/**
 * Regressietest op het echte rekeningschema van office 21007, zoals gemeten op
 * 2 september 2026. Verschuift een van deze regels, dan verschuift de NOI —
 * en dat moet opvallen in de test, niet pas op het dashboard.
 */
test("regressie: het echte 21007-schema classificeert zoals vastgelegd", () => {
  const verwacht: Array<[string, string, string]> = [
    ["4612", "Rente leningen Mogelijk", "interest"],
    ["7000", "Inkoop goederen", "opex"],
    ["8004", "Omzet Chaletpark de Wierde", "revenue"],
    ["8000", "Omzet Verhuur", "revenue"],
    ["4631", "Rente r/c groepsmaatschappijen", "interest-intercompany"],
    ["4623", "Rente lening Collin Crowdfund (44488)", "interest"],
    ["7700", "Werkzaamheden derden", "opex"],
    ["4745", "Onderhoudscontracten computers/software", "opex"],
    ["4805", "Accountantskosten", "opex"],
    ["4460", "Onroerend-zaak belasting", "opex"],
    ["4639", "Rente belastingen", "opex"],
    ["4653", "Kosten lening Collin Crowdfund (44488)", "opex"],
    ["4610", "Rente lening Resonandina Holanda B.V. (42294)", "interest"],
    ["4658", "Kosten lening Resonandina Holanda B.V. (42294)", "opex"],
    ["4677", "Boetes belastingen", "opex"],
  ];
  for (const [code, naam, cat] of verwacht) {
    assert.equal(classifyPnl(code, naam), cat, `${code} ${naam}`);
  }
});

// ─── balansrekeningen voor het leningregister ─────────────────────────

test("leninghoofdsommen worden herkend", () => {
  assert.equal(isLoanPrincipalAccount("Lening Mogelijk"), true);
  assert.equal(isLoanPrincipalAccount("Mogelijk BV hypotheek"), true);
  assert.equal(isLoanPrincipalAccount("Lening Collin Crowdfund"), true);
});

test("rekening-courant is geen lening", () => {
  // Anders zou de r/c-hoofdsom in de WACC-noemer belanden terwijl de rente er
  // bewust uit gehaald is — precies de fout die punt 4 oploste, omgekeerd.
  assert.equal(isLoanPrincipalAccount("Rekening-courant groepsmaatschappijen"), false);
});

test("aflossings- en reclass-rekeningen zijn geen hoofdsom", () => {
  assert.equal(isLoanPrincipalAccount("Cumulatieve aflossing lening Mogelijk"), false);
  assert.equal(isLoanPrincipalAccount("Afl. lopend jr lening Mogelijk"), false);
  assert.equal(isLoanPrincipalAccount("Aflossingsverplichting langlopend"), false);
});

test("lege of naamloze rekeningen tellen niet mee", () => {
  assert.equal(isLoanPrincipalAccount(""), false);
  assert.equal(isLoanPrincipalAccount(), false);
});

test("cumulatieve aflossing en jaaraflossing zijn los herkenbaar", () => {
  assert.equal(isCumulativeRepaymentAccount("Cumulatieve aflossing Mogelijk"), true);
  assert.equal(isCumulativeRepaymentAccount("Afl. lopend jr Mogelijk"), false);
  assert.equal(isCurrentPrincipalAccount("Afl. lopend jr Mogelijk"), true);
  assert.equal(isCurrentPrincipalAccount("Cumulatieve aflossing Mogelijk"), false);
});

test("intercompany-herkenning dekt de gangbare schrijfwijzen", () => {
  for (const naam of [
    "Rente r/c groepsmaatschappijen",
    "Rente rekening-courant",
    "Rente rekening courant directie",
    "Rente groepsmaatschappij X",
  ]) {
    assert.equal(isIntercompanyInterestAccount(naam), true, naam);
  }
  assert.equal(isIntercompanyInterestAccount("Rente leningen Mogelijk"), false);
});
