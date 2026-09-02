// Naam-gebaseerde rekening-classificatie voor het Twinfield-rekeningschema van
// de Sirrapa-administraties (gedeeld template). Robuuster dan kale code-prefixes:
// de echte rekeningnamen bepalen de KPI-categorie. Bevestigd op office 21007
// (Vastgoed — Chaletpark De Wierde), waar leningen in 16xx staan i.p.v. 07/08.

export type PnlCategory =
  | "revenue"
  | "interest"
  | "interest-intercompany"
  | "depreciation"
  | "tax"
  | "opex"
  | "ignore";

/**
 * Rentelast op de rekening-courant met groepsmaatschappijen.
 *
 * Moet apart van de externe rente blijven: `isLoanPrincipalAccount` sluit r/c
 * uit het leningregister uit, dus als deze rente wél in de teller zou zitten
 * krijg je rente zonder bijbehorende hoofdsom in de noemer — WACC en DSCR
 * worden dan structureel te ongunstig. (Gemeten sep 2026 op office 21007:
 * €6.931 van €73.584 totale rente, goed voor ~1 procentpunt WACC.)
 */
export function isIntercompanyInterestAccount(name = ""): boolean {
  const n = name.toLowerCase().trim();
  return (
    n.includes("r/c") ||
    n.includes("rekening-courant") ||
    n.includes("rekening courant") ||
    n.includes("groepsmaatschappij")
  );
}

/**
 * Classificeer een grootboekrekening voor de P&L op basis van code + naam.
 * - omzet: 8xxx (bv. "Omzet Verhuur", "Omzet Chaletpark de Wierde")
 * - rente (debt service): kostenrekening met naam die met "rente" begint,
 *   behalve belastingrente (bv. "Rente leningen Mogelijk", "Rente lening Collin")
 * - afschrijving / vpb apart; de rest is operationele kosten (voor NOI).
 *
 * BEVESTIGD 2026-09-02 — twee gevallen die de KPI-uitkomst bepalen en niet uit
 * de rekeningcode volgen. Beide zijn door de eigenaar vastgesteld, niet
 * afgeleid; zie de operationaliseringstabel in
 * `kpis/KPIs_per_werkmaatschappij.md`:
 *
 *   8004 "Omzet Chaletpark de Wierde"  → huurinkomst, geen handelsomzet
 *   7000 "Inkoop goederen"             → exploitatiekost, geen kostprijs
 *                                        van doorverkoop
 *
 * Daarmee is de negatieve NOI op office 21007 een reëel signaal en geen
 * classificatiefout. Verandert het rekeningschema, of komt er handel bij op
 * dezelfde rekeningen, dan moet die tabel (en deze aanname) herzien worden.
 */
export function classifyPnl(code: string, name = ""): PnlCategory {
  const n = name.toLowerCase().trim();
  if (code.startsWith("8")) return "revenue";
  if (!/^[4567]/.test(code)) return "ignore"; // geen P&L-kostenrekening
  if (n.startsWith("afschrijving")) return "depreciation";
  if (n.includes("vennootschapsbelasting")) return "tax";
  if (n.startsWith("rente") && !n.includes("belasting")) {
    return isIntercompanyInterestAccount(n) ? "interest-intercompany" : "interest";
  }
  return "opex";
}

/**
 * Balansrekening die een leninghoofdsom vertegenwoordigt (langlopend vreemd
 * vermogen). Sluit rekening-courant, cumulatieve aflossing en de
 * kortlopende-aflossing-reclass uit.
 */
export function isLoanPrincipalAccount(name = ""): boolean {
  const n = name.toLowerCase().trim();
  if (!n) return false;
  if (n.includes("rekening-courant")) return false;
  if (n.startsWith("cumulatieve aflossing")) return false;
  if (n.startsWith("afl. lopend jr")) return false;
  if (n.startsWith("aflossingsverplichting")) return false;
  return n.includes("lening") || n.startsWith("mogelijk");
}

/** Balansrekening met de aflossing van het lopende jaar ("afl. lopend jr ..."). */
export function isCurrentPrincipalAccount(name = ""): boolean {
  return name.toLowerCase().trim().startsWith("afl. lopend jr");
}

/**
 * Contra-rekening met de tot nu toe gedane aflossing ("Cumulatieve aflossing
 * ..."). Wordt afgetrokken van de hoofdsom om de netto openstaande schuld te
 * bepalen.
 */
export function isCumulativeRepaymentAccount(name = ""): boolean {
  return name.toLowerCase().trim().startsWith("cumulatieve aflossing");
}
