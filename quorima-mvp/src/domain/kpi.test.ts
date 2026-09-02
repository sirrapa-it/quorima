import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDSCR, computeNOI, computeRefiRunway } from "./kpi.js";
import type { Loan, PnLReport } from "../types.js";

const pnl = (totals: Partial<PnLReport["totals"]>): PnLReport => ({
  entityId: "sirrapa-vastgoed",
  period: { year: 2026, period: "FY" },
  currency: "EUR",
  lines: [],
  totals: {
    revenue: 0,
    operatingExpenses: 0,
    interestExpense: 0,
    interestExpenseIntercompany: 0,
    depreciation: 0,
    tax: 0,
    netResult: 0,
    ...totals,
  },
});

const loan = (over: Partial<Loan> = {}): Loan => ({
  id: "l1",
  lender: "Mogelijk",
  balance: 664026,
  currency: "EUR",
  rate: 0.1004,
  nextRepricingDate: null,
  fixedPeriodEnd: null,
  monthlyPrincipal: 23237.4 / 12,
  ...over,
});

// ─── NOI ──────────────────────────────────────────────────────────────

test("NOI = omzet min operationele kosten, per maand", () => {
  const out = computeNOI(pnl({ revenue: 120000, operatingExpenses: 60000 }), null);
  assert.equal(out.monthly, 5000);
  assert.equal(out.rentalIncome, 120000);
  assert.equal(out.operatingExpenses, 60000);
});

test("NOI negeert rente, afschrijving en belasting", () => {
  const out = computeNOI(
    pnl({
      revenue: 120000,
      operatingExpenses: 60000,
      interestExpense: 70000,
      interestExpenseIntercompany: 7000,
      depreciation: 24000,
      tax: 5000,
    }),
    null,
  );
  assert.equal(out.monthly, 5000, "alleen omzet en opex bepalen de NOI");
});

test("NOI zonder budget krijgt geen health-status", () => {
  const out = computeNOI(pnl({ revenue: 100, operatingExpenses: 50 }), null);
  assert.equal(out.status, "no-budget");
  assert.equal(out.budgetEur, null);
  assert.equal(out.varianceVsBudget, null);
});

test("NOI met budget: groen op of boven, geel net eronder, rood daaronder", () => {
  const p = pnl({ revenue: 120000, operatingExpenses: 60000 }); // 5000/mnd
  assert.equal(computeNOI(p, 5000).status, "green");
  assert.equal(computeNOI(p, 4000).status, "green");
  assert.equal(computeNOI(p, 5400).status, "yellow", "5000/5400 = 0,93");
  assert.equal(computeNOI(p, 8000).status, "red", "5000/8000 = 0,63");
});

test("NOI-variantie is het verschil met het budget", () => {
  const out = computeNOI(pnl({ revenue: 120000, operatingExpenses: 60000 }), 6000);
  assert.equal(out.varianceVsBudget, -1000);
});

test("NOI kan negatief zijn — dat is een uitkomst, geen fout", () => {
  // De echte stand van office 21007 in september 2026.
  const out = computeNOI(pnl({ revenue: 33925.43, operatingExpenses: 43431.35 }), null);
  assert.ok(out.monthly < 0);
  assert.equal(Math.round(out.monthly), -792);
});

// ─── DSCR ─────────────────────────────────────────────────────────────

test("DSCR = NOI gedeeld door rente plus aflossing", () => {
  const out = computeDSCR(
    pnl({ revenue: 200000, operatingExpenses: 100000, interestExpense: 40000 }),
    [loan({ monthlyPrincipal: 10000 / 12 })],
  );
  assert.equal(out.noi12m, 100000);
  assert.equal(out.debtService12m, 50000);
  assert.equal(out.value, 2);
  assert.equal(out.status, "green");
});

test("DSCR gebruikt alleen externe rente; intercompany blijft erbuiten", () => {
  // Dit is de correctie uit punt 4: 6.930,58 r/c-rente hoort niet in de noemer,
  // want de bijbehorende hoofdsom zit ook niet in het leningregister.
  const out = computeDSCR(
    pnl({
      revenue: 33925.43,
      operatingExpenses: 43431.35,
      interestExpense: 66653.79,
      interestExpenseIntercompany: 6930.58,
    }),
    [loan({ monthlyPrincipal: 23237.4 / 12 })],
  );
  assert.equal(out.debtService12m, 89891, "66.654 + 23.237, zonder de r/c-rente");
  assert.equal(out.interestIntercompany12m, 6930.58, "wel apart gerapporteerd");
  assert.equal(out.value, -0.106, "de echte stand van 21007 in september 2026");
});

test("DSCR-drempels: groen vanaf 1,25 · geel vanaf 1,0 · daaronder rood", () => {
  const mk = (noi: number) =>
    computeDSCR(pnl({ revenue: noi, operatingExpenses: 0, interestExpense: 100000 }), []).status;
  assert.equal(mk(130000), "green");
  assert.equal(mk(125000), "green");
  assert.equal(mk(110000), "yellow");
  assert.equal(mk(100000), "yellow");
  assert.equal(mk(99000), "red");
});

test("DSCR zonder schuld is Infinity, niet een deling door nul", () => {
  const out = computeDSCR(pnl({ revenue: 100000, operatingExpenses: 50000 }), []);
  assert.equal(out.debtService12m, 0);
  assert.equal(out.value, Infinity);
  assert.equal(out.status, "green");
});

test("negatieve NOI geeft een negatieve DSCR en blijft rood", () => {
  const out = computeDSCR(
    pnl({ revenue: 10000, operatingExpenses: 20000, interestExpense: 50000 }),
    [],
  );
  assert.ok(out.value < 0);
  assert.equal(out.status, "red");
});

// ─── refi-runway ──────────────────────────────────────────────────────

test("WACC is het naar saldo gewogen gemiddelde van de rentes", () => {
  const out = computeRefiRunway([
    loan({ id: "a", balance: 300000, rate: 0.1 }),
    loan({ id: "b", balance: 100000, rate: 0.06 }),
  ]);
  assert.equal(out.totalDebt, 400000);
  assert.equal(out.wacc, 0.09, "(300k*10% + 100k*6%) / 400k");
});

test("zonder schuld is WACC 0 en niet NaN", () => {
  const out = computeRefiRunway([]);
  assert.equal(out.wacc, 0);
  assert.equal(out.totalDebt, 0);
});

test("zonder repricing-datum is de runway Infinity", () => {
  // De reden dat de logregel ooit "Infinitymo" toonde (punt 7).
  const out = computeRefiRunway([loan()]);
  assert.equal(out.earliestRepricingMonths, Infinity);
});

test("de kortste repricing over alle leningen telt", () => {
  const asOf = new Date("2026-01-01T00:00:00Z");
  const out = computeRefiRunway(
    [
      loan({ id: "a", nextRepricingDate: "2026-07-01" }),
      loan({ id: "b", nextRepricingDate: "2026-04-01" }),
    ],
    asOf,
  );
  assert.ok(out.earliestRepricingMonths < 3.1 && out.earliestRepricingMonths > 2.9);
});

test("een repricing in het verleden wordt niet negatief", () => {
  const out = computeRefiRunway([loan({ nextRepricingDate: "2020-01-01" })], new Date("2026-01-01"));
  assert.equal(out.earliestRepricingMonths, 0);
});

test("fixedPeriodEnd geldt als er geen expliciete repricing-datum is", () => {
  const asOf = new Date("2026-01-01T00:00:00Z");
  const out = computeRefiRunway([loan({ fixedPeriodEnd: "2026-04-01" })], asOf);
  assert.ok(Number.isFinite(out.earliestRepricingMonths));
});

test("status is worst-of-two-axes: hoge WACC alleen maakt al rood", () => {
  // Precies de situatie van Vastgoed: repricing onbekend, maar WACC 10%.
  const out = computeRefiRunway([loan({ rate: 0.1004 })], new Date(), { waccRedPct: 7 });
  assert.equal(out.status, "red");
});

test("status is worst-of-two-axes: korte runway alleen maakt ook rood", () => {
  const out = computeRefiRunway(
    [loan({ rate: 0.02, nextRepricingDate: "2026-02-01" })],
    new Date("2026-01-01"),
    { waccRedPct: 7, refiRedMonths: 6 },
  );
  assert.equal(out.status, "red");
});

test("lage WACC en ruime runway is groen", () => {
  const out = computeRefiRunway(
    [loan({ rate: 0.03, nextRepricingDate: "2029-01-01" })],
    new Date("2026-01-01"),
  );
  assert.equal(out.status, "green");
});
