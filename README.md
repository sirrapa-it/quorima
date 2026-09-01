# Quorima

Agentic C-level board (SaaS) voor **Sirrapa Group Holding B.V.** (100% Armand Parris). Een Chief of Staff orchestreert vier C-level agents (CEO/CFO/COO/CMO) over de holding en drie werkmaatschappijen (Sirrapa ICT, Sirrapa Vastgoed, Sirrapa Property Group Ltd). Alle redeneerwerk via Claude API + Agent SDK; tools volgen `domain.action`; escalaties lopen altijd via Chief of Staff → `escalate_to_human()`.

## Componenten

| Map | Wat | Status |
|---|---|---|
| `agent_prompts/` | system-prompts: Chief of Staff + CEO/CFO/COO/CMO | 📋 prompts; alleen CFO draait als code |
| `quorima-mvp/` | werkende CFO daily-flash (TS): ports/adapters, KPI-engine, escalatie, digest | ✅ draait dagelijks live op Hermes |
| `kpis/` | KPI-definities per werkmaatschappij, UK-acquisitie en holding | 📋 gedefinieerd; NOI-definitie wijkt af van de code (zie beperkingen) |
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

### Bekende beperkingen (stand 1 september 2026)

Live data is niet hetzelfde als correcte data. Voordat je op een cijfer stuurt:

- **De NOI-definitie in de code wijkt af van `kpis/KPIs_per_werkmaatschappij.md`.**
  De KPI-doc zegt "bruto huur − operationele kosten"; de implementatie neemt álle
  8xxx-omzet minus álle niet-rente kosten, inclusief `7000 Inkoop goederen`.
  Daardoor staat DSCR op dit moment negatief. Welke rekeningen meetellen is nog
  niet vastgelegd — behandel DSCR/NOI als indicatief tot dat gebeurd is.
- ~~**WACC is overschat**~~ — *opgelost.* Intercompany r/c-rente is uit zowel de
  WACC-teller als de DSCR-schuldendienst gehaald en wordt apart gerapporteerd
  (`interestIntercompany12m`). WACC 11,08% → 10,04%, debt service €96.822 →
  €89.891. Resteert een kleine overschatting doordat de rente over het
  jaargemiddelde wordt gedeeld door het eindsaldo; op te lossen zodra er
  run-historie is.
- **Repricing-datums ontbreken** (geen leningadministratie), dus de "maanden tot
  herfinanciering"-helft van KPI 3 is altijd onbekend en de escalatie draait
  puur op WACC.
- **Er wordt geen historie bewaard**, dus KPI-regels die twee perioden
  vergelijken (DSCR 2 kwartalen op rij, NOI YoY) kunnen niet vuren.
- **Geen unit-tests** op de KPI- en classificatie-laag.
