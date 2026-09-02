// Twinfield AccountingPort — production adapter.
//
// We gebruiken de SOAP processxml-service met OAuth2-authenticatie. De oude
// Session.Logon (user + Webservice key) is door Twinfield uitgezet en geeft
// `OAuth2AuthenticationRequired`; zie connectors/twinfield_oauth2_migration.md.
//
// Architectuur:
//   1. OAuth2 → access_token (refresh headless, zie oauth.ts)
//   2. Cluster discovery → accesstokenvalidation geeft twf.clusterUrl
//   3. Process XML → POST <cluster>/webservices/processxml.asmx?wsdl met
//      AccessToken + CompanyCode (office) in de SOAP-header, BrowseXML /
//      ColumnsXML voor grootboek-queries
//
// Voor de eerste iteratie van de MVP focussen we op de minimale set
// queries die de drie KPIs voeden: P&L, transactions per account-prefix,
// en lening-saldi (uit balans-rekeningen).

import * as soap from "soap";
import type {
  Account,
  BalanceSheet,
  Entity,
  EntityId,
  Loan,
  OpenItem,
  Period,
  PnLReport,
  Tenancy,
  Transaction,
} from "../../types.js";
import type { AccountingPort, TxFilter } from "../../ports/accounting.js";
import { getValidAccessContext, type OAuthClientConfig } from "./oauth.js";
import { withRateLimitRetry } from "./retry.js";
import {
  classifyPnl,
  isCumulativeRepaymentAccount,
  isCurrentPrincipalAccount,
  isLoanPrincipalAccount,
} from "./account-classify.js";

export interface TwinfieldConfig extends OAuthClientConfig {
  /** pad naar de lokale token-store met het refresh_token (gitignored) */
  tokenStorePath: string;
}

export class TwinfieldAccountingPort implements AccountingPort {
  private processXmlClient: soap.Client | null = null;
  private clientClusterUrl: string | null = null;
  private namesByOffice = new Map<string, Map<string, string>>();
  private relNamesByKey = new Map<string, Map<string, string>>();

  constructor(private config: TwinfieldConfig) {}

  // ─── Connection lifecycle (OAuth2 / OpenID Connect) ─────────────────
  //
  // Twinfield's oude Session.Logon (user + Webservice key) is uitgezet en
  // geeft `OAuth2AuthenticationRequired`. We halen per call een geldig
  // access_token + clusterUrl op (refresh headless via oauth.ts) en zetten
  // AccessToken + CompanyCode in de SOAP-header. CompanyCode = de office,
  // dus die varieert per entiteit en wordt per call ververst.

  private async ensureProcessClient(clusterUrl: string): Promise<soap.Client> {
    if (this.processXmlClient && this.clientClusterUrl === clusterUrl) {
      return this.processXmlClient;
    }
    const wsdl = `${clusterUrl}/webservices/processxml.asmx?wsdl`;
    this.processXmlClient = await soap.createClientAsync(wsdl);
    this.clientClusterUrl = clusterUrl;
    return this.processXmlClient;
  }

  private async callProcessXml(office: string, xmlRequest: string): Promise<string> {
    // Twinfield knijpt af met een 429; zonder retry valt de hele dagelijkse run
    // om op een fout die zich voordoet als "Invalid XML". Zie retry.ts.
    return withRateLimitRetry(
      async () => {
        const { accessToken, clusterUrl } = await getValidAccessContext(
          this.config,
          this.config.tokenStorePath,
        );
        const client = await this.ensureProcessClient(clusterUrl);
        client.clearSoapHeaders();
        client.addSoapHeader(
          { Header: { AccessToken: accessToken, CompanyCode: office } },
          "",
          "tw",
          "http://www.twinfield.com/",
        );
        const [result] = await client.ProcessXmlStringAsync({ xmlRequest });
        return result.ProcessXmlStringResult as string;
      },
      { onRetry: (msg) => console.error(`  ⏳ ${msg}`) },
    );
  }

  /**
   * Grootboekrekening-namen (code → naam) per office, uit de dimensie-lijst.
   * Nodig om P&L- en lening-rekeningen op naam te classificeren i.p.v. op
   * een aangenomen code-prefix. Gecached per office.
   */
  private async ensureNames(office: string): Promise<Map<string, string>> {
    const cached = this.namesByOffice.get(office);
    if (cached) return cached;
    const names = new Map<string, string>();
    for (const dimtype of ["BAS", "PNL"]) {
      const xml = await this.callProcessXml(
        office,
        `<list><type>dimensions</type><office>${office}</office><dimtype>${dimtype}</dimtype></list>`,
      );
      // Twinfield-vorm: <dimension name="..." shortname="">CODE</dimension>
      for (const m of xml.matchAll(/<dimension[^>]*\bname="([^"]*)"[^>]*>([^<]+)<\/dimension>/g)) {
        names.set(m[2]!.trim(), m[1]!);
      }
    }
    this.namesByOffice.set(office, names);
    return names;
  }

  /**
   * Relatie-namen (code → naam) per office voor crediteuren (CRD) of
   * debiteuren (DEB). Nodig om de dim2-relatie op de controlerekening te
   * benoemen. Gecached per office+dimtype.
   */
  private async ensureRelationNames(
    office: string,
    dimtype: "CRD" | "DEB",
  ): Promise<Map<string, string>> {
    const key = `${office}:${dimtype}`;
    const cached = this.relNamesByKey.get(key);
    if (cached) return cached;
    const names = new Map<string, string>();
    const xml = await this.callProcessXml(
      office,
      `<list><type>dimensions</type><office>${office}</office><dimtype>${dimtype}</dimtype></list>`,
    );
    for (const m of xml.matchAll(/<dimension[^>]*\bname="([^"]*)"[^>]*>([^<]+)<\/dimension>/g)) {
      names.set(m[2]!.trim(), m[1]!);
    }
    this.relNamesByKey.set(key, names);
    return names;
  }

  // ─── Public AccountingPort interface ────────────────────────────────

  async listEntities(): Promise<Entity[]> {
    // Twinfield's cluster-level "list offices" returns the offices
    // (administraties) the user is authorised for. For Sirrapa we map
    // the three offices to canonical Quorima entities.
    const officeIds = [
      process.env.TWINFIELD_OFFICE_VASTGOED,
      process.env.TWINFIELD_OFFICE_ICT,
      process.env.TWINFIELD_OFFICE_HOLDING,
    ].filter(Boolean) as string[];

    const ids: Record<string, EntityId> = {
      [process.env.TWINFIELD_OFFICE_VASTGOED ?? "21007"]: "sirrapa-vastgoed",
      [process.env.TWINFIELD_OFFICE_ICT ?? "21005"]: "sirrapa-ict",
      [process.env.TWINFIELD_OFFICE_HOLDING ?? "21006"]: "sirrapa-holding",
    };
    const names: Record<string, string> = {
      [process.env.TWINFIELD_OFFICE_VASTGOED ?? "21007"]: "Sirrapa Vastgoed B.V.",
      [process.env.TWINFIELD_OFFICE_ICT ?? "21005"]: "Sirrapa (ICT) B.V.",
      [process.env.TWINFIELD_OFFICE_HOLDING ?? "21006"]: "Sirrapa Group Holding B.V.",
    };

    return officeIds.map((office) => ({
      id: ids[office] ?? `twinfield-${office}`,
      legalName: names[office] ?? `Office ${office}`,
      country: "NL",
      currency: "EUR",
      gaap: "nl-gaap",
    }));
  }

  async getPnL(entityId: EntityId, period: Period): Promise<PnLReport> {
    const office = officeFromEntityId(entityId);

    // Echt rollend 12-maands venster, eindigend op de huidige maand
    // (nooit in de toekomst — anders mist YTD-data het voorgaande jaar).
    const periodEnd = periodEndDate(period);
    const now = new Date();
    const end = periodEnd < now ? periodEnd : now;
    const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
    const fromYM = formatYearMonth(start);
    const toYM = formatYearMonth(end);

    // Twinfield browse code 000 = grootboektransacties. Eén regel per
    // transactieregel; we aggregeren client-side per rekening (dim1).
    // Kolommen moeten <visible>true</visible> zijn om als <td> terug te komen.
    const browse = `<columns code="000">
  <column><field>fin.trs.line.dim1</field><visible>true</visible></column>
  <column><field>fin.trs.line.valuesigned</field><visible>true</visible></column>
  <column><field>fin.trs.head.yearperiod</field><operator>between</operator><from>${fromYM}</from><to>${toYM}</to><visible>false</visible></column>
</columns>`;

    const [xml, names] = await Promise.all([
      this.callProcessXml(office, browse),
      this.ensureNames(office),
    ]);
    return parsePnLFromBrowseXml(xml, names, entityId, period);
  }

  async getBalanceSheet(entityId: EntityId, asOf: string): Promise<BalanceSheet> {
    const office = officeFromEntityId(entityId);
    const ym = formatYearMonth(new Date(asOf));

    // Balans = cumulatief saldo per rekening t/m de periode. We lezen alle
    // transactieregels t/m ${ym} (code 000) en sommeren client-side per dim1.
    const browse = `<columns code="000">
  <column><field>fin.trs.line.dim1</field><visible>true</visible></column>
  <column><field>fin.trs.line.valuesigned</field><visible>true</visible></column>
  <column><field>fin.trs.head.yearperiod</field><operator>between</operator><from>2000/00</from><to>${ym}</to><visible>false</visible></column>
</columns>`;

    const xml = await this.callProcessXml(office, browse);
    return parseBalanceSheetFromBrowseXml(xml, entityId, asOf);
  }

  async listAccounts(entityId: EntityId): Promise<Account[]> {
    const office = officeFromEntityId(entityId);
    const listXml = `<list><type>dimensions</type><office>${office}</office><dimtype>BAS</dimtype></list>`;
    const xml = await this.callProcessXml(office, listXml);
    return parseAccountsList(xml);
  }

  async listTransactions(entityId: EntityId, filter: TxFilter): Promise<Transaction[]> {
    const office = officeFromEntityId(entityId);
    const fromYM = filter.from ? formatYearMonth(new Date(filter.from)) : "2026/01";
    const toYM = filter.to ? formatYearMonth(new Date(filter.to)) : formatYearMonth(new Date());

    const browse = `<columns code="000">
  <column><field>fin.trs.head.code</field><visible>true</visible></column>
  <column><field>fin.trs.head.number</field><visible>true</visible></column>
  <column><field>fin.trs.head.date</field><visible>true</visible></column>
  <column><field>fin.trs.line.dim1</field><visible>true</visible></column>
  <column><field>fin.trs.line.description</field><visible>true</visible></column>
  <column><field>fin.trs.line.debitvalue</field><visible>true</visible></column>
  <column><field>fin.trs.line.creditvalue</field><visible>true</visible></column>
  <column><field>fin.trs.head.yearperiod</field><operator>between</operator><from>${fromYM}</from><to>${toYM}</to><visible>false</visible></column>
  ${filter.accountCodePrefix ? `<column><field>fin.trs.line.dim1</field><operator>between</operator><from>${filter.accountCodePrefix}0</from><to>${filter.accountCodePrefix}9</to><visible>false</visible></column>` : ""}
</columns>`;
    const xml = await this.callProcessXml(office, browse);
    return parseTransactionsBrowseXml(xml, entityId);
  }

  async listOpenItems(entityId: EntityId): Promise<OpenItem[]> {
    // De crediteuren-/debiteuren-sub-administratie-browses (code 100/200) geven
    // op deze Twinfield-cluster een server-fout. We leiden de openstaande posten
    // daarom af uit het grootboek (code 000, dat wél werkt): het netto saldo per
    // relatie (dim2) op de controlerekening. Een volledig betaalde relatie netto
    // 0 → valt weg; het restsaldo per relatie = wat nog openstaat. Per-factuur-
    // detail (factuurnr/vervaldatum) is zo niet te halen, per-relatie wél.
    const office = officeFromEntityId(entityId);
    const ym = formatYearMonth(new Date());
    const browse = `<columns code="000">
  <column><field>fin.trs.line.dim1</field><visible>true</visible></column>
  <column><field>fin.trs.line.dim2</field><visible>true</visible></column>
  <column><field>fin.trs.line.valuesigned</field><visible>true</visible></column>
  <column><field>fin.trs.head.yearperiod</field><operator>between</operator><from>2000/00</from><to>${ym}</to><visible>false</visible></column>
</columns>`;
    const [xml, accNames, crd, deb] = await Promise.all([
      this.callProcessXml(office, browse),
      this.ensureNames(office),
      this.ensureRelationNames(office, "CRD"),
      this.ensureRelationNames(office, "DEB"),
    ]);

    // Controlerekeningen op naam detecteren (robuust over offices):
    // "Handelscrediteuren …" = crediteuren (AP), "Debiteuren" = debiteuren (AR).
    const apAccounts = new Set<string>();
    const arAccounts = new Set<string>();
    for (const [code, name] of accNames) {
      if (/handelscrediteuren|^crediteuren/i.test(name)) apAccounts.add(code);
      else if (/^debiteuren\b/i.test(name)) arAccounts.add(code);
    }

    const byRel = new Map<string, number>(); // key: dim1|dim2
    for (const row of parseBrowseRows(xml)) {
      const d1 = row["fin.trs.line.dim1"] ?? "";
      if (!apAccounts.has(d1) && !arAccounts.has(d1)) continue;
      const d2 = row["fin.trs.line.dim2"] ?? "";
      const key = `${d1}|${d2}`;
      byRel.set(key, (byRel.get(key) ?? 0) + parseAmount(row["fin.trs.line.valuesigned"]));
    }

    const items: OpenItem[] = [];
    for (const [key, net] of byRel) {
      if (Math.abs(net) < 0.005) continue;
      const sep = key.indexOf("|");
      const d1 = key.slice(0, sep);
      const d2 = key.slice(sep + 1);
      if (apAccounts.has(d1)) {
        // Crediteur: credit-saldo (negatief) = te betalen. Een debet-saldo
        // (positief) = vooruitbetaald aan de crediteur (een tegoed).
        items.push({
          side: "payable",
          kind: net < 0 ? "open" : "prepaid",
          entityId,
          office,
          relationCode: d2,
          relationName: crd.get(d2) || d2 || "(onbekende crediteur)",
          amountEur: Math.abs(net),
        });
      } else {
        // Debiteur: debet-saldo (positief) = te ontvangen. Een credit-saldo
        // (negatief) = vooruitontvangen van de debiteur (een schuld).
        items.push({
          side: "receivable",
          kind: net > 0 ? "open" : "prepaid",
          entityId,
          office,
          relationCode: d2,
          relationName: deb.get(d2) || d2 || "(onbekende debiteur)",
          amountEur: Math.abs(net),
        });
      }
    }
    items.sort((a, b) => b.amountEur - a.amountEur);
    return items;
  }

  async deriveLoanRegister(entityId: EntityId): Promise<Loan[]> {
    // Leningen staan in deze administratie niet op 07/08 maar als benoemde
    // 16xx-rekeningen (bv. "Lening Collin Crowdfund", "Mogelijk ... kavel").
    // We detecteren ze op naam (zie account-classify) i.p.v. op code-prefix:
    //   - hoofdsom  → totale schuld
    //   - "afl. lopend jr ..." → jaaraflossing (principal voor DSCR)
    //   - rente uit de P&L → gewogen rente (WACC)
    const office = officeFromEntityId(entityId);
    const ym = formatYearMonth(new Date());
    const browse = `<columns code="000">
  <column><field>fin.trs.line.dim1</field><visible>true</visible></column>
  <column><field>fin.trs.line.valuesigned</field><visible>true</visible></column>
  <column><field>fin.trs.head.yearperiod</field><operator>between</operator><from>2000/00</from><to>${ym}</to><visible>false</visible></column>
</columns>`;
    const [xml, names] = await Promise.all([
      this.callProcessXml(office, browse),
      this.ensureNames(office),
    ]);

    // Netto openstaande schuld = hoofdsom (credit, negatief) + reeds gedane
    // cumulatieve aflossing (debet, positief).
    let principalSigned = 0;
    let repaidSigned = 0;
    let annualPrincipal = 0;
    let loanAccounts = 0;
    for (const [account, amount] of aggregateByAccount(xml)) {
      const name = names.get(account) ?? account;
      if (isLoanPrincipalAccount(name) && Math.abs(amount) > 0) {
        principalSigned += amount;
        loanAccounts += 1;
      } else if (isCumulativeRepaymentAccount(name)) {
        repaidSigned += amount;
      } else if (isCurrentPrincipalAccount(name)) {
        annualPrincipal += Math.abs(amount);
      }
    }
    const totalBalance = Math.abs(principalSigned + repaidSigned);
    if (totalBalance === 0) return [];

    // Gewogen rente uit de rentelasten in de P&L (rolling 12m).
    //
    // `interestExpense` bevat alléén EXTERNE rente — intercompany r/c-rente
    // zit in `interestExpenseIntercompany` en hoort hier niet, omdat de
    // r/c-hoofdsom ook niet in `totalBalance` zit (zie isLoanPrincipalAccount).
    // Teller en noemer moeten over dezelfde schuld gaan.
    //
    // Let op: `totalBalance` is het EINDsaldo na cumulatieve aflossing, terwijl
    // de rente over het jaargemiddelde is opgebouwd. Bij een aflopende lening
    // overschat dat de rentevoet licht. Structureel op te lossen zodra er
    // run-historie is (punt 10) — tot dan een bekende, kleine overschatting.
    const pnl = await this.getPnL(entityId, { year: new Date().getFullYear(), period: "FY" });
    const portfolioRate = pnl.totals.interestExpense / totalBalance;

    // Eén geaggregeerde lening-regel die de KPI-sommen correct voedt
    // (totaal saldo, jaaraflossing, gewogen rente). Per-lening detail en
    // repricing-datums volgen uit de leningadministratie/contract-store.
    return [
      {
        id: `loan-portfolio-${office}`,
        lender: `Leningen (${loanAccounts} hoofdsom-rekeningen)`,
        balance: totalBalance,
        currency: "EUR",
        rate: portfolioRate,
        nextRepricingDate: null,
        fixedPeriodEnd: null,
        monthlyPrincipal: annualPrincipal / 12,
      },
    ];
  }

  async deriveRentRoll(_entityId: EntityId): Promise<Tenancy[]> {
    // Vergelijkbare beperking: zonder Vastgoed-module geen
    // contract-metadata. Lease summary komt in Quorima via PDF-parsing
    // pipeline (Sprint 1.5). Hier returnen we een lege array — de CFO
    // agent kan toch DSCR/NOI berekenen want die hangen op grootboek.
    return [];
  }
}

// ─── XML parsers ────────────────────────────────────────────────────
// Voor de MVP zijn dit minimal-effort regex-based parsers. In productie
// vervangen we ze door een proper XML lib (fast-xml-parser) plus tests.

export function parsePnLFromBrowseXml(
  xml: string,
  names: Map<string, string>,
  entityId: EntityId,
  period: Period,
): PnLReport {
  const lines: PnLReport["lines"] = [];
  let revenue = 0;
  let opex = 0;
  let interest = 0;
  let interestIntercompany = 0;
  let depreciation = 0;
  let tax = 0;

  for (const [account, signed] of aggregateByAccount(xml)) {
    const name = names.get(account) ?? account;
    const category = classifyPnl(account, name);
    if (category === "ignore") continue;
    // Opbrengsten staan credit (valuesigned negatief) → positief maken;
    // kosten staan debet (positief) en houden hun teken.
    //
    // Bewust GEEN Math.abs op de kostenkant: een kostenrekening kan over de
    // periode netto credit staan (een creditnota, een teruggedraaide boeking,
    // een te hoge accrual die is bijgesteld). Dat is per saldo een bate en
    // hoort de opex te verlagen. Math.abs maakte er een positieve kostenpost
    // van en overschatte de kosten dus precies in het geval waarin er iets
    // ongewoons met een rekening was gebeurd.
    const amount = category === "revenue" ? -signed : signed;
    switch (category) {
      case "revenue": revenue += amount; break;
      case "interest": interest += amount; break;
      case "interest-intercompany": interestIntercompany += amount; break;
      case "depreciation": depreciation += amount; break;
      case "tax": tax += amount; break;
      default: opex += amount;
    }
    lines.push({ account, name, amount });
  }

  return {
    entityId,
    period,
    currency: "EUR",
    lines,
    totals: {
      revenue,
      operatingExpenses: opex,
      interestExpense: interest,
      interestExpenseIntercompany: interestIntercompany,
      depreciation,
      tax,
      // Intercompany-rente is wél een echte last voor het resultaat, alleen
      // geen schuldendienst — zie de toelichting bij PnLReport.totals.
      netResult: revenue - opex - interest - interestIntercompany - depreciation - tax,
    },
  };
}

function parseBalanceSheetFromBrowseXml(xml: string, entityId: EntityId, asOf: string): BalanceSheet {
  const byAccount = aggregateByAccount(xml);
  const lines: BalanceSheet["lines"] = [];
  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;

  for (const [account, amount] of byAccount) {
    // Alleen balansrekeningen: 0xxx (vast) / 1xxx (vlottend).
    // 07xx/08xx = langlopend vreemd vermogen (leningen), 05xx/06xx = EV.
    if (!/^[01]/.test(account)) continue;
    let side: "asset" | "liability" | "equity";
    if (/^0[78]/.test(account)) side = "liability";
    else if (/^0[56]/.test(account)) side = "equity";
    else side = "asset";

    if (side === "asset") totalAssets += amount;
    else if (side === "liability") totalLiabilities += Math.abs(amount);
    else totalEquity += Math.abs(amount);

    lines.push({ account, name: account, amount, side });
  }

  return {
    entityId,
    asOf,
    currency: "EUR",
    lines,
    totals: { totalAssets, totalLiabilities, totalEquity },
  };
}

function parseAccountsList(xml: string): Account[] {
  // Twinfield <list> response wraps <dimension code="..." name="..." />
  const out: Account[] = [];
  const dimRe = /<dimension[\s\S]*?code="([^"]+)"[\s\S]*?name="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = dimRe.exec(xml)) !== null) {
    const code = m[1]!;
    const name = m[2]!;
    let type: Account["type"] = "asset";
    if (code.startsWith("4")) type = "expense";
    else if (code.startsWith("8")) type = "income";
    else if (code.startsWith("07") || code.startsWith("08")) type = "liability";
    else if (code.startsWith("05")) type = "equity";
    out.push({ code, name, type });
  }
  return out;
}

function parseTransactionsBrowseXml(xml: string, entityId: EntityId): Transaction[] {
  const out: Transaction[] = [];
  for (const row of parseBrowseRows(xml)) {
    const code = row["fin.trs.head.code"] ?? "";
    const number = row["fin.trs.head.number"] ?? "";
    if (!code && !number) continue;
    out.push({
      id: `${code}-${number}`,
      entityId,
      date: row["fin.trs.head.date"] ?? "",
      account: row["fin.trs.line.dim1"] ?? "",
      description: row["fin.trs.line.description"] ?? "",
      debit: parseAmount(row["fin.trs.line.debitvalue"]),
      credit: parseAmount(row["fin.trs.line.creditvalue"]),
      currency: "EUR",
    });
  }
  return out;
}

// ─── helpers ────────────────────────────────────────────────────────

function officeFromEntityId(entityId: EntityId): string {
  const map: Record<string, string | undefined> = {
    "sirrapa-vastgoed": process.env.TWINFIELD_OFFICE_VASTGOED ?? "21007",
    "sirrapa-ict": process.env.TWINFIELD_OFFICE_ICT ?? "21005",
    "sirrapa-holding": process.env.TWINFIELD_OFFICE_HOLDING ?? "21006",
  };
  const office = map[entityId];
  if (!office) throw new Error(`No Twinfield office mapping for entity ${entityId}`);
  return office;
}

function formatYearMonth(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function periodEndDate(p: Period): Date {
  if (p.period === "FY") return new Date(p.year, 11, 31);
  if (p.period === "Q1") return new Date(p.year, 2, 31);
  if (p.period === "Q2") return new Date(p.year, 5, 30);
  if (p.period === "Q3") return new Date(p.year, 8, 30);
  if (p.period === "Q4") return new Date(p.year, 11, 31);
  return new Date(p.year, p.period as number, 0);
}

/**
 * Parse een Twinfield <browse>-respons naar rijen. Elke rij is een map van
 * veldnaam → waarde, gelezen uit <td field="...">waarde</td>. De <key>-elementen
 * en niet-zichtbare kolommen worden genegeerd.
 */
function parseBrowseRows(xml: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(xml)) !== null) {
    const cells: Record<string, string> = {};
    const tdRe = /<td\b[^>]*\bfield="([^"]+)"[^>]*>([^<]*)<\/td>/g;
    let c: RegExpExecArray | null;
    while ((c = tdRe.exec(m[1]!)) !== null) cells[c[1]!] = (c[2] ?? "").trim();
    rows.push(cells);
  }
  return rows;
}

// Twinfield browse-waarden gebruiken een punt-decimaal en minteken (bv. -121.00).
function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s.replace(/\s/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Aggregeer een browse-respons tot signed saldo per grootboekrekening (dim1).
function aggregateByAccount(xml: string): Map<string, number> {
  const byAccount = new Map<string, number>();
  for (const row of parseBrowseRows(xml)) {
    const account = row["fin.trs.line.dim1"];
    if (!account) continue;
    byAccount.set(account, (byAccount.get(account) ?? 0) + parseAmount(row["fin.trs.line.valuesigned"]));
  }
  return byAccount;
}
