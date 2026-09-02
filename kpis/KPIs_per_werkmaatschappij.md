# Quorima — KPI's per werkmaatschappij

Versie: v0.2 · 26 april 2026
Holding: **Sirrapa Group Holding B.V.** (100% Armand Parris)

> Voor elke werkmaatschappij definiëren we 3 KPI's, gekozen op basis van de **huidige operationele realiteit** (niet generieke branche-defaults). Deze 3 vormen de "must-watch" set die de C-level agents elke board cycle bewaken; de wizard biedt straks per entity-type een uitgebreidere library, maar dit is wat *altijd* zichtbaar is.

---

## 1. Sirrapa (ICT) B.V.

**Profiel:** Solo freelance ICT-vehikel. Armand factureert 36 uur/week bij één opdrachtgever. Goal: meer omzet (= klant-diversificatie + uitbreiding capaciteit/tarief).

**Belangrijkste risico op dit moment: 100% klant-concentratie.** Eén beëindiging = volledige omzet-stop.

| # | KPI | Formule / definitie | Data bron | Health-drempels | Escalatie-trigger |
|---|---|---|---|---|---|
| 1 | **Klant-concentratie %** | (Omzet grootste klant in laatste 12mnd) / (Totale omzet 12mnd) × 100 | Boekhouding (debiteuren, facturen) | Groen ≤ 40% · Geel 41–70% · Rood > 70% | > 80% gedurende 2+ kwartalen → CEO-flag (urgent diversification) |
| 2 | **Effectieve maandomzet** | Σ(gefactureerde uren × tarief) per kalender-maand | Facturen + urenregistratie | Groen ≥ doelstelling · Geel 80–99% · Rood < 80% | < 70% van target voor 2e maand → CFO-flag (run-rate mismatch) |
| 3 | **Pipeline diversificatie-index** | Aantal "qualified" prospects waar concrete opdracht-gesprekken lopen, gewogen × kans (CRM stages) | CRM (HubSpot) of Notion-pipeline | Groen ≥ 2 actieve · Geel 1 · Rood 0 | 0 actieve prospects + concentratie > 80% → CEO/CMO joint flag |

### Waarom deze drie en niet "billable utilization" of "NRR"
- Utilization is hier per definitie ~100% (1 contract, 36u/week vast) — meet niets.
- NRR/MRR vereist meerdere contracten — niet aanwezig.
- Concentratie + diversificatie-pipeline meten precies de *enige* dimensie waarop deze BV stuurbaar is: het van-1-naar-meer-klanten traject.

### Bonus-metrics (niet primair, wel zichtbaar)
- **Effectief uurtarief trend** (€/u, lopend gemiddelde 6 maanden) — voor latere onderhandelingen.
- **Bench-uren** zodra > 0 (= moment dat capaciteit vrij komt voor klant 2).

---

## 2. Sirrapa Vastgoed B.V.

**Profiel:** Income-led portefeuille met **business contracts** (commerciële huurders). Hoge rente op financiering veroorzaakt **negatieve cashflow** op groepsniveau. Acuut financieel onder druk.

**Belangrijkste signaal: DSCR < 1.0 betekent dat huurinkomsten de rentelasten niet dekken.** Dat is een covenant-risico en een refinance-druk.

| # | KPI | Formule / definitie | Data bron | Health-drempels | Escalatie-trigger |
|---|---|---|---|---|---|
| 1 | **DSCR (Debt Service Coverage Ratio)** | NOI / (Rente + aflossing) over rolling 12mnd | Boekhouding (rentelasten) + huurregister + leningadministratie | Groen ≥ 1.25 · Geel 1.00–1.24 · Rood < 1.00 | DSCR < 1.0 voor 2 opeenvolgende kwartalen → onmiddellijke CFO+CEO-flag (covenant + refinance) |
| 2 | **Net Operating Income (NOI), maandelijks** | Bruto huur − operationele kosten (excl. rente, afschrijving, belasting) | Boekhouding + property mgmt | Groen ≥ budget · Geel 90–99% · Rood < 90% | > 10% NOI-uitval YoY → COO-investigatie (vacancy / kosten) |
| 3 | **Gewogen rentelast & herfinancieringsruimte** | (a) WACC schuld %, (b) Maanden tot eerstvolgende rente-/aflos-trigger of fixed-period einde | Leningenoverzicht | Groen: WACC < 5% én > 18 mnd vrij · Geel: WACC 5–7% of 6–18 mnd · Rood: WACC > 7% of < 6 mnd | < 6 maanden tot herfinanciering bij DSCR < 1.0 → CFO/CEO crisis-protocol |

### Operationalisering op het Twinfield-rekeningschema (bevestigd 2026-09-02)

De formules hierboven zijn kort; dit is hoe ze op office 21007 concreet gerekend
worden. Vastgelegd omdat de review van 1 september terecht constateerde dat
"bruto huur" en "operationele kosten" meerdere lezingen toelieten — met een
DSCR-uitkomst tussen −0,36 en +0,19 afhankelijk van de interpretatie.

| Post | Rekeningen | Telt mee in |
|---|---|---|
| **Bruto huur** | alle `8xxx` — zowel `8000 Omzet Verhuur` als `8004 Omzet Chaletpark de Wierde` | NOI (teller) |
| **Operationele kosten** | alle `4xxx`–`7xxx` behalve rente, afschrijving en VpB — **inclusief `7000 Inkoop goederen`** | NOI (aftrek) |
| **Rente (schuldendienst)** | kostenrekening met naam beginnend op "rente", niet-belasting, **niet-intercompany** | DSCR (noemer) |
| **Intercompany r/c-rente** | naam bevat "r/c" / "rekening-courant" / "groepsmaatschappij" | apart gerapporteerd, **buiten** DSCR en WACC |
| **Aflossing** | `afl. lopend jr ...` | DSCR (noemer) |

Twee beslissingen die niet uit het grootboek volgen en dus hier horen:

1. **`8004 Omzet Chaletpark de Wierde` is huurinkomst** (verhuur van plaatsen en
   chalets), geen handelsomzet. Telt dus volledig mee als bruto huur.
2. **`7000 Inkoop goederen` is een exploitatiekost** van het park, geen
   kostprijs van doorverkoop. Telt dus mee als operationele kost.

> ⚠️ **Bijgesteld 2 september 2026.** Bovenstaande afbakening staat, maar de
> uitkomst is verschoven door een parserfout die los van deze definitie stond:
> een `Math.abs` telde een netto **credit**saldo op `7000 Inkoop goederen`
> (−€26.508) als positieve kostenpost. Met het teken intact is de NOI
> **+€3.626/mnd** en de DSCR **+0,484**, in plaats van −€792 en −0,106.
>
> Openstaand: klopt het bedrijfseconomisch dat dit creditsaldo als bate telt?
> Bij een rollend 12-maandsvenster kan een tegenboeking binnen het venster
> vallen terwijl de oorspronkelijke kost erbuiten ligt; dan is de NOI
> kunstmatig hoog. Tot dat is nagekeken is de NOI **onbevestigd**.

> Wijzigt het rekeningschema, of komt er een handelsactiviteit bij die op
> dezelfde rekeningen boekt, dan moet deze tabel mee — anders verschuift de KPI
> stilletjes van betekenis.

### Waarom deze drie en niet "RevPAR" of "IRR per project"
- Eerdere aanname (holiday rentals) was niet correct — het is commerciële verhuur met business contracts.
- IRR is een development-metric; de zwaartekracht ligt nu bij exploitatie + financiering.
- DSCR + NOI + refi-runway zijn samen de *survival triangle* voor een rente-gevoelige real-estate BV.

### Bonus-metrics
- **WAULT (Weighted Average Unexpired Lease Term)** — vermindert herfinancieringsrisico bij lange contracten.
- **Bezettingsgraad %** — backup om NOI-daling te diagnosticeren.
- **LTV** — als debt nog kan worden bijgenomen voor liquiditeit, of juist niet.

### Acute aanbevelingen die de CFO-agent direct genereert
1. Monthly DSCR scenario — wat als rente +50 bps stijgt? Wanneer breekt covenant?
2. Refi-roadmap — welke leningen/welke LTV's komen wanneer vrij; welke lender-categorieën zouden lager bieden.
3. Cost compression — operational expense reductie scenario (property mgmt, energie, verzekering).

---

## 3. Sirrapa Property Group Ltd.

**Profiel:** UK property, **develop-to-hold** strategie (build/refurb → behouden voor rental income). Acquisitie- en bouwfase per object, daarna stabilisatie naar verhuurportefeuille.

**Belangrijkste meting: yield-on-cost bij stabilisatie.** Dat is wat develop-to-hold scheidt van flip-and-sell — je houdt de yield, niet de capital gain bij verkoop.

| # | KPI | Formule / definitie | Data bron | Health-drempels | Escalatie-trigger |
|---|---|---|---|---|---|
| 1 | **Stabilized Yield-on-Cost** | (NOI bij target-bezetting & target-rent) / (Totale ontwikkelkost incl. acquisitie + works) | Project budget + rent forecast | Groen ≥ 7% · Geel 5.5–6.9% · Rood < 5.5% | Per project bij planning < 6% → CEO go/no-go decision moment |
| 2 | **Time-to-Stabilization** (mnd) | Mnd van acquisitie tot project ≥ 90% verhuurd op target rent | Project tracker + huurregister | Groen ≤ plan · Geel +1–3 mnd · Rood > +3 mnd | > +6 mnd vs plan → COO/CEO joint review |
| 3 | **Stabilized portfolio Net Yield + DSCR** | (Net rental income / current market value) + DSCR op portfolio-debt | Valuation + leningen + huur | Groen Yield ≥ 5.5% én DSCR ≥ 1.4 · Geel een van beide afwijkend · Rood beide afwijkend | DSCR < 1.2 of yield < 4.5% → CFO portfolio-rebalance flag |

### Waarom deze drie
- "Develop-to-hold" combineert bouw-fase met exploitatie-fase. Eén KPI dekt elk: **#1 is build-economics**, **#2 is delivery-discipline**, **#3 is portfolio-gezondheid post-stabilisatie**.
- GDV/cost is nuttig in een flip-strategie maar niet hier — de exit is verhuur, niet verkoop.

### Bonus-metrics
- **WAULT** op stabilized portfolio.
- **Cap rate ontwikkeling vs UK markt** (Knight Frank / Savills indices).
- **Construction cost overruns vs budget** per project.

---

## Cross-entity samenvatting voor de board

| Werkmaatschappij | KPI #1 | KPI #2 | KPI #3 | Primaire agent |
|---|---|---|---|---|
| Sirrapa (ICT) B.V. | Klant-concentratie % | Effectieve maandomzet | Pipeline diversificatie | CMO + CEO |
| Sirrapa Vastgoed B.V. | DSCR | NOI maandelijks | Rente / refi-runway | CFO + CEO |
| Sirrapa Property Group Ltd. | Stabilized yield-on-cost | Time-to-stabilization | Portfolio yield + DSCR | CFO + COO |

### Holding-niveau composietweergave
- **Cashflow consolidatie** (EUR): ICT cash in + Vastgoed NL cash uit (negatief) + UK Property project cash demand → netto holding cashflow.
- **Concentratie-risico holding-breed**: zowel klant-concentratie ICT als asset-concentratie Vastgoed (top-3 panden % NOI).
- **Capital allocation**: hoeveel cash uit ICT moet doorgesluisd worden om DSCR Vastgoed NL te overbruggen, en hoeveel UK-projecten kan dit nog dragen?

---

## Hoe deze KPI's worden geïmplementeerd

1. **Wizard-templates** — drie entity-type templates worden aan de Sirrapa-tenant toegewezen tijdens setup: `ICT-Solo-Freelance`, `Property-Income-Geared`, `Property-Develop-to-Hold`. Elk template laadt deze KPI-definities, drempelwaarden en escalatie-triggers automatisch.
2. **CFO agent prompt** krijgt een `kpi_library` injectie per entiteit met deze definities zodat consistentie verzekerd is.
3. **Daily flash digest** rapporteert deze 3 KPI's per BV als eerste sectie, vóór alle andere details.
4. **Audit log** bewaart elke KPI-berekening met onderliggende tool-calls voor traceerbaarheid.
