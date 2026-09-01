// Quorima — Canonical domain types
// Iedere connector mapt zijn vendor-specifieke data naar deze types.
// Agents werken alleen tegen deze types — vendor-onafhankelijk.

export type ISO4217 = "EUR" | "GBP" | "USD";
export type EntityId = string;

export interface Entity {
  id: EntityId;
  legalName: string;
  country: "NL" | "GB" | string;
  currency: ISO4217;
  gaap: "nl-gaap" | "frs-102" | "ifrs" | string;
}

export interface Period {
  year: number;
  /** 1..12 for monthly periods; "Q1".."Q4" for quarterly; "FY" for full year */
  period: number | "Q1" | "Q2" | "Q3" | "Q4" | "FY";
}

export interface Account {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
}

export interface Transaction {
  id: string;
  entityId: EntityId;
  date: string; // ISO yyyy-mm-dd
  account: string; // grootboek code
  description: string;
  debit: number;
  credit: number;
  currency: ISO4217;
  costCenter?: string;
  counterAccount?: string;
}

export interface PnLLine {
  account: string;
  name: string;
  amount: number; // positive = income, negative = expense
}

export interface PnLReport {
  entityId: EntityId;
  period: Period;
  currency: ISO4217;
  lines: PnLLine[];
  totals: {
    revenue: number;
    /** Operationele kosten — excl. rente, afschrijving en belasting (NOI-basis). */
    operatingExpenses: number;
    /**
     * Rente op EXTERNE schuld (Mogelijk, Collin, bank). Dit is de teller van
     * WACC en zit in de DSCR-debt-service. Intercompany-rente staat apart.
     */
    interestExpense: number;
    /**
     * Rente op rekening-courant met groepsmaatschappijen. Bewust gescheiden:
     * de bijbehorende hoofdsom zit niet in het leningregister, dus meetellen
     * zou WACC en DSCR vertekenen (rente zonder schuld in de noemer). Wel
     * onderdeel van het netto resultaat, niet van de schuldendienst.
     */
    interestExpenseIntercompany: number;
    depreciation: number;
    tax: number;
    netResult: number;
  };
}

export interface BalanceSheetLine {
  account: string;
  name: string;
  amount: number;
  side: "asset" | "liability" | "equity";
}

export interface BalanceSheet {
  entityId: EntityId;
  asOf: string;
  currency: ISO4217;
  lines: BalanceSheetLine[];
  totals: {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
  };
}

export interface Loan {
  id: string;
  lender: string;
  balance: number;
  currency: ISO4217;
  /** Annual nominal interest rate, decimal (0.05 = 5%) */
  rate: number;
  /** Date when next repricing happens (ISO yyyy-mm-dd). null = never reprices. */
  nextRepricingDate: string | null;
  /** End of fixed-rate period (ISO). null = floating */
  fixedPeriodEnd: string | null;
  /** Monthly principal repayment */
  monthlyPrincipal: number;
}

export interface Tenancy {
  id: string;
  tenantName: string;
  monthlyRent: number;
  contractStart: string;
  contractEnd: string | null;
  /** Index clause (e.g. "CPI+1%" or "fixed 3%/y") */
  indexation: string | null;
  /** Break option date if any */
  breakOption: string | null;
}

export interface AccountMapping {
  rentalIncome: string[];
  operatingExpenses: {
    maintenance: string[];
    propertyManagement: string[];
    utilities: string[];
    insurance: string[];
    other?: string[];
  };
  interestExpense: string[];
  loansPayable: string[];
  cashAccounts: string[];
}

// ─── KPI computation results ─────────────────────────────────────────

export interface DSCRResult {
  value: number;
  noi12m: number;
  debtService12m: number;
  /** Rente op externe schuld — onderdeel van de debt service. */
  interest12m: number;
  /** Intercompany r/c-rente — apart getoond, telt NIET mee in debt service. */
  interestIntercompany12m: number;
  principal12m: number;
  status: "green" | "yellow" | "red";
  thresholds: { green: number; yellow: number; red: number };
}

export interface NOIResult {
  monthly: number;
  rentalIncome: number;
  operatingExpenses: number;
  status: "green" | "yellow" | "red" | "no-budget";
  budgetEur: number | null;
  varianceVsBudget: number | null;
}

export interface RefiRunwayResult {
  /** Weighted average annual interest rate, decimal */
  wacc: number;
  /** Months until next repricing trigger, considering all loans */
  earliestRepricingMonths: number;
  totalDebt: number;
  status: "green" | "yellow" | "red";
}

export interface VastgoedFlash {
  asOf: string;
  entity: Entity;
  dscr: DSCRResult;
  noi: NOIResult;
  refi: RefiRunwayResult;
  /** Notable transactions in last 24h */
  recentMaterialTx?: Transaction[];
  /** Aggregated escalations */
  escalations: Escalation[];
}

export interface Escalation {
  level: "info" | "warning" | "critical";
  rule: string;
  message: string;
  recipients: string[];
}

/**
 * Openstaande post per relatie (crediteur of debiteur). Afgeleid uit het
 * grootboek: netto saldo per relatie op de crediteuren-/debiteuren-
 * controlerekening. Per-factuur-detail (factuurnr/vervaldatum) is op deze
 * Twinfield-cluster niet via processxml beschikbaar (matchstatus-browse faalt).
 */
export interface OpenItem {
  side: "payable" | "receivable";
  /**
   * `open`    = normaal openstaand (crediteur te betalen / debiteur te ontvangen).
   * `prepaid` = tegengesteld saldo: vooruitbetaald aan een crediteur (tegoed)
   *             of vooruitontvangen van een debiteur (schuld).
   */
  kind: "open" | "prepaid";
  entityId: EntityId;
  /** Twinfield office (administratie) */
  office: string;
  /** relatie-code (dim2) en -naam */
  relationCode: string;
  relationName: string;
  /** EUR, altijd positief = de omvang van het saldo */
  amountEur: number;
}
