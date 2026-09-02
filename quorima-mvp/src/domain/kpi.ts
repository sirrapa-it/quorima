// Quorima — KPI calculators voor Vastgoed (Sirrapa)
// Pure functies die alleen canonical types als input nemen.

import type {
  DSCRResult,
  Loan,
  NOIResult,
  PnLReport,
  RefiRunwayResult,
} from "../types.js";

const DEFAULT_DSCR_THRESHOLDS = { green: 1.25, yellow: 1.0, red: 1.0 };
const DEFAULT_WACC_RED_PCT = 7.0;
const DEFAULT_WACC_YELLOW_PCT = 5.0;
const DEFAULT_REFI_RED_MONTHS = 6;
const DEFAULT_REFI_YELLOW_MONTHS = 18;

/**
 * Net Operating Income — bruto huurinkomsten minus operationele kosten,
 * exclusief rente, afschrijving en belasting.
 *
 * Volgt de definitie uit Quorima KPI's per werkmaatschappij (Vastgoed NL). Welke
 * grootboekrekeningen onder "bruto huur" en "operationele kosten" vallen is
 * geen detail maar bepaalt de sign van de uitkomst; die afbakening staat in de
 * operationaliseringstabel van dat document en wordt uitgevoerd door
 * `classifyPnl` in de Twinfield-adapter.
 *
 * Let op: `monthly` kan negatief zijn. Dat is geen foutwaarde — het betekent dat
 * de exploitatie vóór financieringslasten verlies draait, en het maakt de
 * afgeleide DSCR eveneens negatief. Een negatieve DSCR is dan geen
 * dekkingsgraad meer; behandel hem als "geen dekking", niet als een ratio die
 * je met 1,0 vergelijkt.
 */
export function computeNOI(pnl: PnLReport, budgetEurMonthly: number | null): NOIResult {
  const months = periodLengthInMonths(pnl);
  const noi12m = pnl.totals.revenue - pnl.totals.operatingExpenses;
  const monthly = noi12m / months;

  if (budgetEurMonthly == null) {
    return {
      monthly,
      rentalIncome: pnl.totals.revenue,
      operatingExpenses: pnl.totals.operatingExpenses,
      status: "no-budget",
      budgetEur: null,
      varianceVsBudget: null,
    };
  }

  const variance = monthly - budgetEurMonthly;
  const ratio = monthly / budgetEurMonthly;

  let status: NOIResult["status"];
  if (ratio >= 1.0) status = "green";
  else if (ratio >= 0.9) status = "yellow";
  else status = "red";

  return {
    monthly,
    rentalIncome: pnl.totals.revenue,
    operatingExpenses: pnl.totals.operatingExpenses,
    status,
    budgetEur: budgetEurMonthly,
    varianceVsBudget: variance,
  };
}

/**
 * Debt Service Coverage Ratio — NOI gedeeld door rente + aflossingen
 * over rolling 12 maanden. < 1.0 betekent: huurinkomsten dekken de
 * financieringskosten niet — covenant-risico.
 */
export function computeDSCR(
  pnl: PnLReport,
  loans: Loan[],
  thresholds = DEFAULT_DSCR_THRESHOLDS,
): DSCRResult {
  const months = periodLengthInMonths(pnl);
  const noi12m = pnl.totals.revenue - pnl.totals.operatingExpenses;
  // Annualize from period
  const annualNoi = (noi12m / months) * 12;

  // Alleen EXTERNE rente telt als schuldendienst. Intercompany r/c-rente wordt
  // apart gerapporteerd: de bijbehorende hoofdsom zit niet in het leningregister,
  // en je herfinanciert geen rekening-courant met je eigen groepsmaatschappij.
  const interest12m = pnl.totals.interestExpense;
  const interestIntercompany12m = pnl.totals.interestExpenseIntercompany;
  // For loans, compute principal repayments per year from monthly schedule
  const principal12m = loans.reduce((sum, l) => sum + l.monthlyPrincipal * 12, 0);

  const debtService12m = interest12m + principal12m;
  const dscr = debtService12m === 0 ? Infinity : annualNoi / debtService12m;

  let status: DSCRResult["status"];
  if (dscr >= thresholds.green) status = "green";
  else if (dscr >= thresholds.yellow) status = "yellow";
  else status = "red";

  return {
    value: roundTo(dscr, 3),
    noi12m: roundTo(annualNoi, 0),
    debtService12m: roundTo(debtService12m, 0),
    interest12m,
    interestIntercompany12m,
    principal12m,
    status,
    thresholds,
  };
}

/**
 * Weighted Average Cost of Capital op de schuld + maanden tot eerstvolgende
 * herfinanciering (kortst over alle leningen). Combineert deze in één
 * health-status.
 */
export function computeRefiRunway(
  loans: Loan[],
  asOf: Date = new Date(),
  opts: {
    waccRedPct?: number;
    waccYellowPct?: number;
    refiRedMonths?: number;
    refiYellowMonths?: number;
  } = {},
): RefiRunwayResult {
  const waccRed = opts.waccRedPct ?? DEFAULT_WACC_RED_PCT;
  const waccYellow = opts.waccYellowPct ?? DEFAULT_WACC_YELLOW_PCT;
  const refiRed = opts.refiRedMonths ?? DEFAULT_REFI_RED_MONTHS;
  const refiYellow = opts.refiYellowMonths ?? DEFAULT_REFI_YELLOW_MONTHS;

  const totalDebt = loans.reduce((s, l) => s + l.balance, 0);
  const wacc = totalDebt === 0
    ? 0
    : loans.reduce((s, l) => s + l.balance * l.rate, 0) / totalDebt;

  const repricingMonths = loans
    .map((l) => {
      const trigger = l.nextRepricingDate ?? l.fixedPeriodEnd;
      if (!trigger) return Infinity;
      return monthsBetween(asOf, new Date(trigger));
    })
    .filter((n) => Number.isFinite(n));

  const earliest = repricingMonths.length > 0
    ? Math.max(0, Math.min(...repricingMonths))
    : Infinity;

  const waccPct = wacc * 100;
  let status: RefiRunwayResult["status"];

  // Worst-of-two-axes
  const waccBad = waccPct > waccRed;
  const waccMid = waccPct > waccYellow;
  const refiBad = earliest < refiRed;
  const refiMid = earliest < refiYellow;

  if (waccBad || refiBad) status = "red";
  else if (waccMid || refiMid) status = "yellow";
  else status = "green";

  return {
    wacc: roundTo(wacc, 4),
    earliestRepricingMonths: Number.isFinite(earliest) ? roundTo(earliest, 1) : Infinity,
    totalDebt,
    status,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

function periodLengthInMonths(pnl: PnLReport): number {
  const p = pnl.period.period;
  if (p === "FY") return 12;
  if (p === "Q1" || p === "Q2" || p === "Q3" || p === "Q4") return 3;
  return 1; // monthly
}

function monthsBetween(from: Date, to: Date): number {
  const diffMs = to.getTime() - from.getTime();
  const days = diffMs / (1000 * 60 * 60 * 24);
  return days / 30.4375;
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
