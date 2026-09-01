// Quorima — Daily flash digest renderer
// Deterministic markdown fallback voor wanneer LLM uitstaat (--no-llm flag).
// Bouwt dezelfde TL;DR-structuur op uit puur de KPI-data.

import type { VastgoedFlash } from "../types.js";

const STATUS_EMOJI = { green: "🟢", yellow: "🟡", red: "🔴", "no-budget": "⚪" } as const;

export function renderDeterministicFlash(input: VastgoedFlash): string {
  const lines: string[] = [];
  const eu = (n: number) => `€${Math.round(n).toLocaleString("nl-NL")}`;

  lines.push(`# Sirrapa Vastgoed — Daily Flash`);
  lines.push(`**${input.asOf}** · entity: ${input.entity.legalName}`);
  lines.push("");

  // TL;DR
  lines.push(`## TL;DR`);
  const headline = pickHeadline(input);
  lines.push(headline);
  lines.push("");

  // Three KPIs
  lines.push(`## De drie KPI's`);
  lines.push(
    `- ${STATUS_EMOJI[input.dscr.status]} **DSCR** ${input.dscr.value} — ` +
      `NOI ${eu(input.dscr.noi12m)}/jr / debt service ${eu(input.dscr.debtService12m)}/jr ` +
      `(rente ${eu(input.dscr.interest12m)} + aflossing ${eu(input.dscr.principal12m)})` +
      // Intercompany-rente telt niet mee in de schuldendienst, maar verzwijgen
      // zou de rentelast kleiner doen lijken dan hij is.
      (input.dscr.interestIntercompany12m
        ? ` · daarnaast ${eu(input.dscr.interestIntercompany12m)} intercompany r/c-rente (buiten debt service)`
        : ""),
  );
  if (input.noi.budgetEur != null) {
    const variance = input.noi.varianceVsBudget ?? 0;
    const sign = variance >= 0 ? "+" : "";
    lines.push(
      `- ${STATUS_EMOJI[input.noi.status]} **NOI** ${eu(input.noi.monthly)}/mnd vs budget ${eu(input.noi.budgetEur)}/mnd (${sign}${eu(variance)})`,
    );
  } else {
    lines.push(
      `- ${STATUS_EMOJI[input.noi.status]} **NOI** ${eu(input.noi.monthly)}/mnd — geen budget geconfigureerd`,
    );
  }
  const repricing = Number.isFinite(input.refi.earliestRepricingMonths)
    ? `eerstvolgende repricing in ${input.refi.earliestRepricingMonths.toFixed(1)} mnd`
    : `repricing-datum onbekend (leningadministratie nog niet geladen)`;
  lines.push(
    `- ${STATUS_EMOJI[input.refi.status]} **Refi-runway** WACC ${(input.refi.wacc * 100).toFixed(2)}% · ` +
      `${repricing} op totaal ${eu(input.refi.totalDebt)} schuld`,
  );
  lines.push("");

  // Escalations / actions
  if (input.escalations.length > 0) {
    lines.push(`## Wat te doen vandaag`);
    for (const e of input.escalations) {
      const tag = e.level === "critical" ? "🚨 KRITIEK" : e.level === "warning" ? "⚠️ Warning" : "ℹ️ Info";
      lines.push(`- **${tag}** — ${e.message}`);
    }
    lines.push("");
  } else {
    lines.push(`## Wat te doen vandaag`);
    lines.push(`Geen actie vereist vandaag — alle KPI's binnen normale parameters.`);
    lines.push("");
  }

  // Recent material transactions
  if (input.recentMaterialTx && input.recentMaterialTx.length > 0) {
    lines.push(`## Materiële mutaties (laatste 24u)`);
    for (const tx of input.recentMaterialTx) {
      const amt = tx.debit > 0 ? `+${eu(tx.debit)}` : `−${eu(tx.credit)}`;
      lines.push(`- ${tx.date} · ${tx.account} · ${amt} — ${tx.description}`);
    }
    lines.push("");
  }

  // Sources
  lines.push(`## Bronnen`);
  lines.push(
    `- twinfield.getPnL(sirrapa-vastgoed, rolling-12m) · twinfield.deriveLoanRegister · twinfield.listTransactions(last-24h)`,
  );
  lines.push(`- Quorima KPI engine v0.1 (DSCR, NOI, refi-runway)`);
  lines.push("");

  lines.push(`---`);
  lines.push(`_Gegenereerd door Quorima · CFO agent (deterministic mode, no LLM)_`);

  return lines.join("\n");
}

function pickHeadline(input: VastgoedFlash): string {
  const critical = input.escalations.find((e) => e.level === "critical");
  if (critical) {
    return `🚨 ${critical.message}`;
  }
  const warning = input.escalations.find((e) => e.level === "warning");
  if (warning) {
    return `⚠️ ${warning.message}`;
  }
  if (input.dscr.status === "red") {
    return `DSCR ${input.dscr.value} onder de 1.0 — huurinkomsten dekken financiering nog niet. Niet acuut kritiek maar volg trend.`;
  }
  return "Alle drie de KPI's binnen veilige bandbreedte. Geen actie vereist vandaag.";
}
