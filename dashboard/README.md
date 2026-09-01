# Quorima - Management dashboard

Cockpit over de agentic C-suite van de holding (Sirrapa Group Holding B.V.): per werkmaatschappij de must-watch KPIs, openstaande flags en de connector-status. De Vastgoed-KPI's en de openstaande posten komen uit **live Twinfield-feeds** die de flash-pipeline werkdagen om 08:00 ververst; de overige entiteiten zijn nog statisch omdat hun connector nog niet gekoppeld is. Live op `dev.quorima.ai` achter Cloudflare Access.

## Bestanden

- `index.html` - het dashboard. Open via de Launch preview of een webserver (de factuur-feed laadt niet via `file://` wegens CORS).
- `data/invoice-overview.json` - de **live** factuur-feed (echte bedragen, mailbox-adressen, Gmail-links). **Gitignored** — gebouwd door `deploy/build-invoice-feed.mjs` op Hermes. Zie "Factuur-feed (Hermes)".
- `data/invoice-overview.example.json` - schema-voorbeeld (wel gecommit). Geen fallback: bij een ontbrekende live feed meldt het dashboard dat er geen feed is.

## Factuur-feed (Hermes)

De sectie "Openstaande facturen · uit de mailbox" komt uit `data/invoice-overview.json`.
Dat is het koppelpunt met de **Hermes Gmail factuur-pipeline** (MyBrain
`03. Areas/financial-control/gmail-invoice-pipeline-unified-spec.md`).

Gebouwd door **`deploy/build-invoice-feed.mjs`**. Dat script leest de
run-artifacts die de Gmail-pipeline toch al schrijft
(`~/.hermes/run-artifacts/gmail-finops-*/`) en zet ze om naar dit contract.
Het is **read-only**: geen Gmail-API, geen tokens, geen mutatie van
Hermes-artifacts. Draait via cron kort na de Gmail-runs (zie
`deploy/quorima-flash.cron`).

### Wat het wel en niet weet

Bedrag en vervaldatum staan in de bron niet als veld maar als **vrije tekst in
de mailbody**. Het script neemt ze alleen over bij een ondubbelzinnige match —
in elk ander geval blijft het veld `null` en toont het dashboard "onbekend".
Liever een leeg veld dan een gegokt bedrag. De `coverage`-sectie in de feed
maakt expliciet hoeveel er bekend is; het dashboard toont dat.

De **entiteit** komt uit de register-evaluatie van de pipeline (hard bewijs) en
valt anders terug op de ontvangende mailbox. Die laatste is volgens de unified
spec `inferred` en *niet genoeg om op te forwarden* — dat verschil staat als
`entity_confidence` in de feed en als "(afgeleid)" in het dashboard.

### Waarom dit iets anders is dan `open-items.json`

Twee bronnen, twee momenten in dezelfde keten:

| | `open-items.json` | `invoice-overview.json` |
|---|---|---|
| Bron | Twinfield grootboek | Gmail-labels |
| Toont | de **geboekte** stand per relatie | facturen die **binnenkomen** per mail |
| Heeft vervaldatum | nee (niet via de API beschikbaar) | soms, uit de mailtekst |
| Mist | wat nog niet geboekt is | wat buiten de mail om binnenkomt |

Het verschil tussen beide is precies wat nog onderweg is.

**Voorbehoud:** een factuur verdwijnt pas uit deze feed bij een
Basecone-bevestiging (`Admin/Finance/Basecone processed`). Betaal je buiten die
route om, dan blijft de post staan. Lees het dus als "ooit als te betalen
gelabeld", niet als "nu zeker onbetaald". Bonnen die al per pinpas betaald zijn
(klasse 3, alleen `Admin/Finance/Invoice` zonder sub-label) worden uitgefilterd.

Contract `quorima.invoice-overview.v1`:

```json
{
  "schema": "quorima.invoice-overview.v1",
  "generated_at": "ISO-8601 met tz",
  "source": "Hermes Gmail factuur-pipeline (Freya) · run-artifacts",
  "source_run": "gmail-finops-20260901-160311",
  "accounts": ["<geautoriseerde mailboxen>"],
  "coverage": {
    "invoices": 0,
    "with_amount": 0,
    "with_due_date": 0,
    "with_entity": 0,
    "with_entity_confirmed": 0,
    "oldest_mail_date": "YYYY-MM-DD|null"
  },
  "invoices": [
    {
      "entity": "SIT|SVG|SGH|SPG|null",
      "entity_confidence": "confirmed-discriminator|document-evidence|inferred-mailbox|null",
      "office": "21005|21006|21007|null",
      "supplier": "string",
      "reference": "bestandsnaam of factuurnummer|null",
      "amount_eur": "0.0|null  (null = niet ondubbelzinnig uit de mailtekst te lezen)",
      "due_date": "YYYY-MM-DD|null",
      "mail_date": "YYYY-MM-DD|null",
      "status": "incasso|monitor|still-to-pay",
      "link": "gmail-permalink|null",
      "note": "string|null",
      "account": "ontvangende mailbox",
      "mail_count": 1
    }
  ]
}
```

`status` mapt op de drie routeringsklassen uit de unified spec. `office` is de
Twinfield office-code = dezelfde codes als in de tenant-config en de
Basecone-routing. `mail_count` > 1 betekent dat meerdere mails (origineel +
herinnering) tot één factuurregel zijn samengevoegd; dat gebeurt alleen bij
gelijke leverancier, bedrag én vervaldatum.

**Privacy:** de live `data/invoice-overview.json` bevat echte bedragen, mailbox-adressen
en Gmail-links en is daarom **gitignored** (de repo is publiek). Alleen
`invoice-overview.example.json` wordt gecommit, puur als schema-voorbeeld.
Het dashboard valt bij een ontbrekende feed **niet** terug op dat voorbeeld —
het meldt "geen factuurfeed bereikbaar". Placeholder-facturen tonen in dezelfde
opmaak als echte is gevaarlijker dan een lege sectie.

## Datastatus (belangrijk)

Conform de CFO-regel "nooit een cijfer zonder bron":

- **Twinfield is live sinds 17 juni 2026** voor drie administraties (21005 ICT,
  21006 Holding, 21007 Vastgoed). De Vastgoed-KPI's (`data/kpi-overview.json`) en
  de openstaande posten (`data/open-items.json`) worden werkdagen 08:00 door de
  flash-pipeline op Hermes ververst.
- **Xero, HubSpot, Ponto en TrueLayer staan nog op `oauth_status: pending`.** De
  ICT- en SPG-kaarten tonen daarom geen waarden, alleen drempels.
- **Verouderingswaarschuwing:** loopt de feed meer dan 3 dagen achter, dan kleurt
  de banner amber en zegt de pagina expliciet hoeveel dagen oud de cijfers zijn.
  Aanleiding: in augustus 2026 faalde de pipeline 16 runs op rij terwijl het
  dashboard onveranderd "live" bleef tonen.
- **Openstaande facturen** komen uit de Hermes Gmail-pipeline via
  `data/invoice-overview.json` (zie "Factuur-feed"), ververst kort na de
  Gmail-runs van 09:00 en 16:00. Andere bron en ander moment dan de Twinfield-posten.
- **De KPI-cijfers zijn indicatief, niet definitief.** De NOI-definitie in de code
  wijkt af van `kpis/KPIs_per_werkmaatschappij.md` — zie "Bekende beperkingen" in
  de hoofd-`README.md`. (De WACC-overschatting is inmiddels opgelost.)

## Bronnen

- `kpis/KPIs_per_werkmaatschappij.md`
- `kpis/UK_C2R_Acquisition_Phase_KPIs.md`
- `wizard/sirrapa_tenant_config.example.json`
- `quorima-mvp/README.md` + `output/flash-2026-04-27.md`
- `agent_prompts/` (rolverdeling C-suite)

## Nog te koppelen

Twinfield (3 administraties) en de Gmail-factuurfeed zijn live. Wat nog ontbreekt:

1. **Xero** voor Sirrapa Property Group Ltd — de SPG-kaart is nu leeg.
2. **HubSpot** voor de pipeline-KPI's van ICT en SPG.
3. **Ponto / TrueLayer** bankfeeds, voor kaspositie naast de geboekte stand.

Brand: Quorima purple `#6b46c1` / navy `#1f3864`, Lato. Zie `branding/logo/BRAND_GUIDE.md`.
