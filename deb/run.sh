#!/bin/sh
# Установленный запускатель DeepSeek Harness (часть пакета dsh-launcher).
# $0 может быть ссылкой (/usr/bin/dsh-launcher -> /opt/dsh-launcher/run.sh),
# поэтому разрешаем цепочку до реального пути.
SELF="$(readlink -f "$0")"
DIR="$(cd "$(dirname "$SELF")" && pwd)"
ELECTRON="$DIR/electron/electron"
SB="$DIR/electron/chrome-sandbox"

# Песочница Chromium — только если её включили в «Настройки → Графика»
# ("sandbox": true в settings.json) и SUID-хелпер настроен (postinst пакета:
# chown root:root + chmod 4755 при установке от root). По умолчанию — без неё:
# на части рабочих столов (Electron 44, Ubuntu 26.04) с песочницей лаунчер
# падает, когда завершается и снова запускается дочерний процесс
# («Перезапустить dsh», перезапуск после сбоя). Окно показывает только
# локальный GUI dsh и свои страницы; внешние ссылки открываются в браузере.
SETTINGS="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-launcher/settings.json"
if [ "$(stat -c '%U:%a' "$SB" 2>/dev/null)" = "root:4755" ] && grep -q '"sandbox": *true' "$SETTINGS" 2>/dev/null; then
  SANDBOX_ARGS=""
else
  SANDBOX_ARGS="--no-sandbox"
fi

LOGDIR="${DSH_LOG_DIR:-$HOME/.local/state/dsh-launcher}"
mkdir -p "$LOGDIR" 2>/dev/null || true
export DSH_LOG_DIR="$LOGDIR"

exec "$ELECTRON" "$DIR" $SANDBOX_ARGS "$@"
