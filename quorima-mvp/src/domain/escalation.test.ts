import { test } from "node:test";
import assert from "node:assert/strict";

import { escalationFingerprint, evaluateVastgoedEscalations } from "./escalation.js";
import type { DSCRResult, NOIResult, RefiRunwayResult } from "../types.js";

const ctx = {
  recipients: { cfo: ["cfo@x"], ceo: ["ceo@x"], coo: ["coo@x"] },
};

const dscrOf = (value: number, status: DSCRResult["status"]): DSCRResult => ({
  value,
  noi12m: value * 1000,
  debtService12m: 89891,
  interest12m: 66653,
  interestIntercompany12m: 6930,
  principal12m: 23237,
  status,
  thresholds: { green: 1.25, yellow: 1.0, red: 1.0 },
});

const noiOf = (status: NOIResult["status"], budget: number | null = null): NOIResult => ({
  monthly: -792,
  rentalIncome: 33925,
  operatingExpenses: 43431,
  status,
  budgetEur: budget,
  varianceVsBudget: budget == null ? null : -1000,
});

const refiOf = (status: RefiRunwayResult["status"], months = Infinity): RefiRunwayResult => ({
  wacc: 0.1004,
  earliestRepricingMonths: months,
  totalDebt: 664026,
  status,
});

const rulesOf = (e: ReturnType<typeof evaluateVastgoedEscalations>) => e.map((x) => x.rule).sort();

// ─── covenant-regel ───────────────────────────────────────────────────

test("covenant: zonder historie-bevestiging blijft het een warning", () => {
  const out = evaluateVastgoedEscalations(dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"), {
    ...ctx,
    dscrBelowOneForTwoQuartersInRow: false,
  });
  assert.ok(rulesOf(out).includes("vastgoed.dscr.below_one"));
  assert.ok(!rulesOf(out).includes("vastgoed.dscr.covenant_protocol"));
});

test("covenant: twee kwartalen op rij maakt het kritiek", () => {
  const out = evaluateVastgoedEscalations(dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"), {
    ...ctx,
    dscrBelowOneForTwoQuartersInRow: true,
  });
  const covenant = out.find((e) => e.rule === "vastgoed.dscr.covenant_protocol");
  assert.ok(covenant, "covenant-protocol hoort te vuren");
  assert.equal(covenant.level, "critical");
  assert.ok(!rulesOf(out).includes("vastgoed.dscr.below_one"), "niet allebei tegelijk");
});

// ─── NOI year-over-year ───────────────────────────────────────────────

test("NOI YoY: uitval groter dan 10% vuurt een warning", () => {
  const out = evaluateVastgoedEscalations(dscrOf(0.5, "red"), noiOf("no-budget"), refiOf("green"), {
    ...ctx,
    noiYoYChangePct: -23.4,
  });
  const yoy = out.find((e) => e.rule === "vastgoed.noi.yoy_drop");
  assert.ok(yoy);
  assert.match(yoy.message, /-23\.4%/);
});

test("NOI YoY: kleine daling vuurt niet", () => {
  const out = evaluateVastgoedEscalations(dscrOf(0.5, "red"), noiOf("no-budget"), refiOf("green"), {
    ...ctx,
    noiYoYChangePct: -4,
  });
  assert.ok(!rulesOf(out).includes("vastgoed.noi.yoy_drop"));
});

test("NOI YoY: onbekend (geen historie) vuurt niet", () => {
  const out = evaluateVastgoedEscalations(dscrOf(0.5, "red"), noiOf("no-budget"), refiOf("green"), {
    ...ctx,
    noiYoYChangePct: null,
  });
  assert.ok(!rulesOf(out).includes("vastgoed.noi.yoy_drop"));
});

test("NOI YoY: verbetering vuurt niet", () => {
  const out = evaluateVastgoedEscalations(dscrOf(0.5, "red"), noiOf("no-budget"), refiOf("green"), {
    ...ctx,
    noiYoYChangePct: 15,
  });
  assert.ok(!rulesOf(out).includes("vastgoed.noi.yoy_drop"));
});

// ─── vingerafdruk ─────────────────────────────────────────────────────

test("vingerafdruk: identieke toestand geeft dezelfde waarde", () => {
  const mk = () =>
    escalationFingerprint(
      evaluateVastgoedEscalations(dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"), ctx),
      dscrOf(-0.106, "red"),
      noiOf("no-budget"),
      refiOf("red"),
    );
  assert.equal(mk(), mk());
});

test("vingerafdruk: dagelijkse ruis in de bedragen verandert hem niet", () => {
  // Dit is de kern: DSCR schuift van -0.106 naar -0.104 en dat is geen nieuws.
  const a = escalationFingerprint(
    evaluateVastgoedEscalations(dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"), ctx),
    dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"),
  );
  const b = escalationFingerprint(
    evaluateVastgoedEscalations(dscrOf(-0.104, "red"), noiOf("no-budget"), refiOf("red"), ctx),
    dscrOf(-0.104, "red"), noiOf("no-budget"), refiOf("red"),
  );
  assert.equal(a, b);
});

test("vingerafdruk: een statuswijziging verandert hem wel", () => {
  const rood = escalationFingerprint(
    evaluateVastgoedEscalations(dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"), ctx),
    dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"),
  );
  const groen = escalationFingerprint(
    evaluateVastgoedEscalations(dscrOf(1.4, "green"), noiOf("no-budget"), refiOf("green"), ctx),
    dscrOf(1.4, "green"), noiOf("no-budget"), refiOf("green"),
  );
  assert.notEqual(rood, groen);
});

test("vingerafdruk: een nieuwe regel verandert hem wel", () => {
  const zonder = escalationFingerprint(
    evaluateVastgoedEscalations(dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"), ctx),
    dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"),
  );
  const met = escalationFingerprint(
    evaluateVastgoedEscalations(dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"), {
      ...ctx, dscrBelowOneForTwoQuartersInRow: true,
    }),
    dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"),
  );
  assert.notEqual(zonder, met, "opschalen naar covenant-protocol is wel degelijk nieuws");
});

test("vingerafdruk: volgorde van escalaties maakt niet uit", () => {
  const e = evaluateVastgoedEscalations(dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"), ctx);
  const a = escalationFingerprint(e, dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"));
  const b = escalationFingerprint([...e].reverse(), dscrOf(-0.106, "red"), noiOf("no-budget"), refiOf("red"));
  assert.equal(a, b);
});
