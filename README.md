# Quorima

Agentic C-level board (SaaS) voor **Sirrapa Group Holding B.V.** (100% Armand Parris). Een Chief of Staff orchestreert vier C-level agents (CEO/CFO/COO/CMO) over de holding en drie werkmaatschappijen (Sirrapa ICT, Sirrapa Vastgoed, Sirrapa Property Group Ltd). Alle redeneerwerk via Claude API + Agent SDK; tools volgen `domain.action`; escalaties lopen altijd via Chief of Staff → `escalate_to_human()`.

## Componenten

| Map | Wat | Status |
|---|---|---|
| `agent_prompts/` | system-prompts: Chief of Staff + CEO/CFO/COO/CMO | 📋 prompts; alleen CFO draait als code |
| `quorima-mvp/` | werkende CFO daily-flash (TS): ports/adapters, KPI-engine, escalatie, digest | ✅ draait dagelijks live op Hermes |
| `kpis/` | KPI-definities per werkmaatschappij, UK-acquisitie en holding | ✅ gedefinieerd + geoperationaliseerd op het rekeningschema |
| `connectors/` | Twinfield (OAuth2) + Xero/HubSpot/Ponto/TrueLayer setup-notities | Twinfield ✅ live, rest 📋 pending |
| `wizard/` | integrator-wizard blueprint, tenant-config, 5 entity-templates | 📋 spec |
| `dashboard/` | management-cockpit, live op `dev.quorima.ai` achter Cloudflare Access | ✅ live Twinfield-feeds |
| `deploy/` | cron-wrapper, systemd-service, tunnel-config, Hermes-runbook | ✅ in productie |
| `branding/`, `strategy/` | brand/IP-plan, groei- en C2R-strategie | assets/docs |

Architectuur-detail: `Quorima_Architectuur_v0.4.docx`. Draaiende deel = één verticale plak (CFO daily-flash voor Vastgoed via de Ports-laag).

## Twee CFO-lagen (Quorima ↔ Hermes)

Naast Quorima draait er al een **tweede CFO-laag** op Hermes — let op het onderscheid:

- **Quorima-CFO** = *board/analyse*: leest Twinfield grootboek → DSCR/NOI/refi + escalaties (deze repo).
- **Hermes-CFO** = *admin/operatie*: de Gmail factuur-pipeline (triage, Basecone-routing, betaalmonitor), always-on op Hermes. Gedocumenteerd in de MyBrain-vault `03. Areas/financial-control/`.

Ze koppelen via de Twinfield office-codes: Hermes duwt facturen de boeken in (Basecone→Twinfield), Quorima leest ze eruit. **Sinds 1 september 2026 loopt de koppeling ook de andere kant op**: `deploy/build-invoice-feed.mjs` leest de run-artifacts van de Gmail-pipeline en schrijft `dashboard/data/invoice-overview.json`, zodat het dashboard naast de *geboekte* stand (Twinfield) ook toont wat er nog *onderweg* is (mailbox). Read-only, geen Gmail-API. Zie `dashboard/README.md` → "Factuur-feed (Hermes)".

## Status / connectiviteit

- **Twinfield is live sinds 17 juni 2026** (OAuth2; de oude SOAP-logon is door
  Twinfield uitgezet). Drie administraties worden dagelijks uitgelezen: 21005
  ICT, 21006 Holding, 21007 Vastgoed. Zie `connectors/twinfield_oauth2_migration.md`.
- **De pipeline draait productie op Hermes**: cron werkdagen 08:00
  (`deploy/quorima-flash.cron`) schrijft `dashboard/data/kpi-overview.json` +
  `open-items.json`; het dashboard staat op `dev.quorima.ai` achter Cloudflare
  Access. Runbook: `deploy/DEPLOY-hermes.md`, dataflow: `docs/architecture.md`.
- **De overige vier connectors staan nog op `oauth_status: pending`**: Xero (SPG/UK),
  HubSpot, Ponto, TrueLayer. Dus: Vastgoed-KPI's zijn echt, de ICT- en
  SPG-kaarten op het dashboard zijn nog leeg.
- Verificatie: `cd quorima-mvp && npm install && npm run flash:dry-run` (Vastgoed
  daily-flash op mock, geen keys nodig); open `dashboard/index.html` via de
  Launch preview.

### Bekende beperkingen (stand 2 september 2026)

Live data is niet hetzelfde als correcte data. Voordat je op een cijfer stuurt:

- ~~**De NOI-definitie wijkt af van de KPI-doc**~~ — *opgehelderd 2 september.*
  De afbakening was dubbelzinnig (DSCR-uitkomst tussen −0,36 en +0,19 afhankelijk
  van de lezing), maar de implementatie bleek correct: `8004 Omzet Chaletpark` is
  huurinkomst en `7000 Inkoop goederen` is een exploitatiekost. Vastgelegd in de
  operationaliseringstabel in `kpis/KPIs_per_werkmaatschappij.md`.
  ⚠️ **De bijbehorende cijfers zijn op 2 september verschoven** door een aparte
  fout in de parser (zie hieronder). Niet −€792/mnd en −0,106, maar **+€3.626/mnd
  en DSCR +0,484**.
- ~~**WACC is overschat**~~ — *opgelost.* Intercompany r/c-rente is uit zowel de
  WACC-teller als de DSCR-schuldendienst gehaald en wordt apart gerapporteerd
  (`interestIntercompany12m`). WACC 11,08% → 10,04%, debt service €96.822 →
  €89.891. Resteert een kleine overschatting doordat de rente over het
  jaargemiddelde wordt gedeeld door het eindsaldo; op te lossen zodra er
  run-historie is.
- ⚠️ **Openstaande vraag: `7000 Inkoop goederen` staat netto €26.508 CREDIT**
  over de rollende 12 maanden. Tot 2 september maakte een `Math.abs` in de
  parser daar een kostenpost van; met het teken intact is het een bate en
  springt de DSCR van −0,106 naar +0,484. De parserfix is onomstreden, maar
  het blijft de vraag of dat creditsaldo bedrijfseconomisch een bate ís —
  bijvoorbeeld een naar de balans geactiveerde inkoop waarvan de tegenboeking
  wél in het venster valt en de oorspronkelijke kost niet. Behandel de NOI als
  onbevestigd tot dit is nagekeken.
- **Repricing-datums ontbreken** (geen leningadministratie), dus de "maanden tot
  herfinanciering"-helft van KPI 3 is altijd onbekend en de escalatie draait
  puur op WACC.
- ~~**Er wordt geen historie bewaard**~~ — *opgelost.* Elke run legt zijn KPI's
  vast in `dashboard/data/kpi-history.jsonl`, met een backfill vanaf 17 juni.
  De covenant-regel (DSCR twee kwartalen op rij) kan daardoor vanaf 1 oktober
  vuren; NOI YoY vanaf medio 2027.
- ~~**Geen unit-tests**~~ — *opgelost.* 93 tests via het ingebouwde `node:test`
  (`npm test`), inclusief regressietests op het echte 21007-rekeningschema.
