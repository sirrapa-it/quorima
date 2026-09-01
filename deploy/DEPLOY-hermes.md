# Quorima op Hermes — deploy-gids

Quorima draait **naast** de Gmail-pipeline op dezelfde always-on VPS, als eigen
geïsoleerde app (eigen map, eigen `.env`, eigen cron, eigen token-store). Ze
delen de host, de Telegram-alerting en de factuurfeed-koppeling — niet de code
of de secrets.

Onderdelen:
- **Daily CFO flash** — Node-CLI via cron, schrijft de digest (LLM = OpenAI/Codex, pluggable).
- **Dashboard** — kleine static server (127.0.0.1) achter **Cloudflare Tunnel + Access**.

---

## 0. Prerequisites op Hermes
- Node ≥ 20 (`node -v`), git, en `cloudflared` (Cloudflare Tunnel).
- Outbound HTTPS naar Twinfield, OpenAI en Telegram.

## 1. Code + dependencies
```bash
cd /home/hermes
git clone git@github.com:sirrapa/quorima.git
cd quorima/quorima-mvp
npm ci
```

## 2. Secrets (komen NIET uit de repo)
Maak `quorima-mvp/.env` (zie `.env.example`):
```env
# Twinfield OAuth
TWINFIELD_CLIENT_ID=quorima
TWINFIELD_CLIENT_SECRET=...
TWINFIELD_REDIRECT_URI=http://localhost:8080/callback
TWINFIELD_OFFICE_VASTGOED=21007
TWINFIELD_OFFICE_ICT=21005
TWINFIELD_OFFICE_HOLDING=21006
# LLM = OpenAI/Codex (default; wisselen kan via QUORIMA_LLM_PROVIDER=gemini|anthropic)
QUORIMA_LLM_PROVIDER=openai
QUORIMA_MODEL_CFO=gpt-4o-mini
OPENAI_API_KEY=...
```

**Token-store overzetten** (geen browser op de VPS nodig): doe de eenmalige
consent lokaal op je laptop (`npm run twinfield:auth`) en kopieer het token:
```bash
scp quorima-mvp/.twinfield-tokens.json hermes:/home/hermes/quorima/quorima-mvp/
```
Het refresh_token werkt overal; de VPS refresht daarna zelf headless.

## 3. Verifiëren
```bash
npm run twinfield:test     # refresh → cluster → offices (read-only)
npm run flash:dry-run      # KPI-keten op mock, geen LLM
npm run flash              # echte data + OpenAI-briefing
```

## 4. Daily flash via cron
`deploy/run-flash.sh` draait de flash en stuurt een Telegram run/fail-melding
(dead-man's-switch). Installeer de cron uit `deploy/quorima-flash.cron`:
```bash
chmod +x deploy/run-flash.sh
crontab -e   # plak de regel + (optioneel) TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
```
Exit codes: `0` ok · `2` kritieke escalatie (run gelukt) · anders fout.

## 5. Dashboard als service
```bash
sudo cp deploy/quorima-dashboard.service /etc/systemd/system/
sudo systemctl enable --now quorima-dashboard
```
Serveert **alleen** `dashboard/` op `127.0.0.1:8787` (geen repo-root → geen
`.env`-lek).

## 5b. Factuurfeed uit de Gmail-pipeline

`deploy/build-invoice-feed.mjs` zet de run-artifacts van de Hermes Gmail-pipeline
om naar `dashboard/data/invoice-overview.json` (gitignored). **Read-only**: het
leest `~/.hermes/run-artifacts/gmail-finops-*/` van schijf, gebruikt geen
Gmail-tokens en muteert niets aan de pipeline.

```bash
node deploy/build-invoice-feed.mjs          # eenmalig, toont dekkingscijfers
```

De Gmail-runs draaien via de hermes-agent gateway om 09:00 en 16:00; de cron-regel
in `deploy/quorima-flash.cron` leest kort daarna de nieuwste artifacts. Ontbreekt
de feed, dan meldt het dashboard dat expliciet — het valt bewust **niet** terug op
de voorbeelddata.

## 6. Cloudflare Tunnel + Access
```bash
cloudflared tunnel login
cloudflared tunnel create quorima
# zet deploy/cloudflared-config.example.yml → ~/.cloudflared/config.yml (vul TUNNEL-ID + hostname)
cloudflared tunnel route dns quorima quorima.jouwdomein.nl
sudo cloudflared service install      # draait de tunnel als service
```
Dan in **Cloudflare Zero Trust → Access → Applications**: voeg
`quorima.jouwdomein.nl` toe met een policy die **alleen jouw e-mail** toelaat.

> Geen reverse proxy nodig. Cloudflare doet TLS + edge + auth; de dashboard-
> server staat alleen op localhost.

## Beveiliging / onderhoud
- Dashboard-data is gevoelig → **Access is verplicht**, niet optioneel.
- `.env` en `.twinfield-tokens.json` staan buiten git (gitignored). Houd ze met
  `chmod 600`.
- Token rotatie/intrekking → herhaal de consent lokaal en kopieer opnieuw.
- OpenAI-key roteren kan los; provider wisselen = alleen `.env` aanpassen.
