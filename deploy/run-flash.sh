#!/usr/bin/env bash
# Quorima daily CFO flash — cron-wrapper met Telegram run/fail-melding
# (dead-man's-switch, zelfde patroon als de Hermes Gmail-pipeline).
#
# Exit codes van de flash: 0 = ok · 2 = kritieke escalatie (wél gelukt) ·
# 3 = gelukt maar digest gedegradeerd (cijfers vers, LLM-duiding mislukt) ·
# anders = echte fout.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../quorima-mvp"

# Optionele Telegram-config uit een gitignored bestand (niet in de repo):
#   TELEGRAM_BOT_TOKEN=...   TELEGRAM_CHAT_ID=...   TELEGRAM_THREAD_ID=...(topic)
[ -f "$HERE/telegram.env" ] && . "$HERE/telegram.env"

notify() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    ${TELEGRAM_THREAD_ID:+--data-urlencode "message_thread_id=${TELEGRAM_THREAD_ID}"} \
    --data-urlencode "text=$1" >/dev/null || true
}

OUT="$(npm run --silent flash 2>&1)"; CODE=$?
TAIL="$(printf '%s\n' "$OUT" | tail -n 20)"

# Bij een kritieke escalatie (2) kan de digest óók gedegradeerd zijn; die
# melding staat bovenaan de markdown en valt buiten de tail, dus los meenemen.
DEGRADED=""
printf '%s\n' "$OUT" | grep -q "Digest gedegradeerd" && DEGRADED=" · ⚠️ LLM-duiding mislukt"

# Is de escalatie nieuws, of staat dezelfde vlag er al weken? Een 🚨 dat elke
# dag identiek is, is geen alarm meer — precies waardoor de 16 storingen van
# augustus onopgemerkt bleven. De melding komt er altijd (dead-man's-switch),
# maar alleen een échte verandering krijgt het alarmicoon.
UNCHANGED="$(printf '%s\n' "$OUT" | sed -n 's/^\[quorima\] escalatie-status: ongewijzigd \(.*\)$/\1/p' | head -1)"

case "$CODE" in
  0) STATUS="✅ Quorima daily flash OK" ;;
  2) if [ -n "$UNCHANGED" ]; then
       STATUS="🔁 Quorima flash — kritieke stand ${UNCHANGED}${DEGRADED}"
     else
       STATUS="🚨 Quorima flash — KRITIEKE escalatie GEWIJZIGD${DEGRADED}"
     fi ;;
  3) STATUS="⚠️ Quorima flash — cijfers vers, LLM-duiding mislukt (dashboard is bij)" ;;
  *) STATUS="❌ Quorima flash FAILED (exit $CODE)" ;;
esac

# Altijd naar stdout (cron schrijft dit naar flash.log) + optioneel Telegram.
printf '[%s] %s\n%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$STATUS" "$TAIL"
notify "$STATUS
$TAIL"

exit "$CODE"
