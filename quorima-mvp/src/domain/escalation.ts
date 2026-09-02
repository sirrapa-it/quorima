// Quorima — Escalation rules engine voor Vastgoed flash digest

import type {
  DSCRResult,
  Escalation,
  NOIResult,
  RefiRunwayResult,
} from "../types.js";

export interface EscalationContext {
  recipients: {
    cfo: string[];
    ceo: string[];
    coo: string[];
  };
  /** True als DSCR al twee opeenvolgende kwartalen onder 1.0 staat (geladen uit historie) */
  dscrBelowOneForTwoQuartersInRow?: boolean;
  /**
   * NOI-verandering in procent t.o.v. ongeveer een jaar geleden, uit de
   * runhistorie. Null als er nog geen vergelijkbare waarneming is.
   */
  noiYoYChangePct?: number | null;
}

export function evaluateVastgoedEscalations(
  dscr: DSCRResult,
  noi: NOIResult,
  refi: RefiRunwayResult,
  ctx: EscalationContext,
): Escalation[] {
  const out: Escalation[] = [];

  // Rule 1 — DSCR < 1.0 voor 2 opeenvolgende kwartalen → covenant + refi protocol
  if (dscr.status === "red" && ctx.dscrBelowOneForTwoQuartersInRow === true) {
    out.push({
      level: "critical",
      rule: "vastgoed.dscr.covenant_protocol",
      message:
        `DSCR ${dscr.value} < 1.0 voor 2e kwartaal op rij. Onmiddellijk covenant-overleg ` +
        `met lenders en refi-protocol activeren.`,
      recipients: [...ctx.recipients.cfo, ...ctx.recipients.ceo],
    });
  } else if (dscr.status === "red") {
    out.push({
      level: "warning",
      rule: "vastgoed.dscr.below_one",
      message:
        `DSCR ${dscr.value} < 1.0 deze periode (NOI €${fmt(dscr.noi12m)} ` +
        `vs debt service €${fmt(dscr.debtService12m)}). Niet acuut covenant maar ` +
        `volgend kwartaal escaleert dit.`,
      recipients: ctx.recipients.cfo,
    });
  }

  // Rule 2 — refinanciering rood (korte runway óf hoge WACC) én DSCR < 1.0 → crisis
  // Benoem de echte trigger: bij onbekende repricing-datum is WACC de driver,
  // niet de (oneindige) runway.
  const refiDriver = Number.isFinite(refi.earliestRepricingMonths)
    ? `Refi-runway ${refi.earliestRepricingMonths.toFixed(1)} mnd`
    : `WACC ${(refi.wacc * 100).toFixed(2)}% (repricing-datum onbekend)`;
  if (refi.status === "red" && dscr.status === "red") {
    out.push({
      level: "critical",
      rule: "vastgoed.refi.crisis_protocol",
      message:
        `${refiDriver} én DSCR ${dscr.value}. ` +
        `Crisis-protocol: lender-gesprek deze week, refi-roadmap binnen 30 dagen.`,
      recipients: [...ctx.recipients.cfo, ...ctx.recipients.ceo],
    });
  } else if (refi.status === "red") {
    out.push({
      level: "warning",
      rule: "vastgoed.refi.short_runway",
      message: `${refiDriver} — start lender-onderzoek deze maand.`,
      recipients: ctx.recipients.cfo,
    });
  }

  // Rule 3 — NOI-uitval. De KPI-doc noemt twee triggers: >10% uitval YoY
  // (COO-onderzoek) en onderprestatie t.o.v. budget. De YoY-variant kon lang
  // niet vuren omdat er geen historie was; sinds die er is, is dit de primaire
  // regel. De budgetvariant blijft als er wél een budget geconfigureerd is.
  if (ctx.noiYoYChangePct != null && ctx.noiYoYChangePct < -10) {
    out.push({
      level: "warning",
      rule: "vastgoed.noi.yoy_drop",
      message:
        `NOI ${ctx.noiYoYChangePct.toFixed(1)}% t.o.v. een jaar geleden ` +
        `(nu €${fmt(noi.monthly)}/mnd). COO-onderzoek: vacancy of stijgende OpEx?`,
      recipients: [...ctx.recipients.cfo, ...ctx.recipients.coo],
    });
  }

  if (noi.status === "red" && noi.varianceVsBudget != null) {
    out.push({
      level: "warning",
      rule: "vastgoed.noi.material_underperform",
      message:
        `NOI €${fmt(noi.monthly)}/mnd vs budget €${fmt(noi.budgetEur ?? 0)} ` +
        `(variance ${noi.varianceVsBudget >= 0 ? "+" : ""}€${fmt(noi.varianceVsBudget)}). ` +
        `COO-onderzoek: vacancy of stijgende OpEx?`,
      recipients: [...ctx.recipients.cfo, ...ctx.recipients.coo],
    });
  }

  return out;
}

/**
 * Stabiele vingerafdruk van de escalatietoestand.
 *
 * Bedoeld om te zien of er sinds de vorige run iets is veránderd, niet of er
 * iets aan de hand is. Bewust zonder bedragen: de DSCR schuift dagelijks een
 * paar duizendsten en dat is geen nieuws. Alleen welke regels vuren, op welk
 * niveau, en de health-status van de drie KPI's.
 *
 * Aanleiding: tussen 17 juni en 1 september vuurden 39 van de 39 geslaagde runs
 * een identieke kritieke escalatie. Een alarm dat elke dag hetzelfde zegt is
 * geen alarm meer — daardoor vielen 16 opeenvolgende storingsmeldingen niet op.
 */
export function escalationFingerprint(
  escalations: Escalation[],
  dscr: DSCRResult,
  noi: NOIResult,
  refi: RefiRunwayResult,
): string {
  const rules = escalations
    .map((e) => `${e.level}:${e.rule}`)
    .sort()
    .join(",");
  return `${rules}|dscr=${dscr.status}|noi=${noi.status}|refi=${refi.status}`;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("nl-NL");
}
