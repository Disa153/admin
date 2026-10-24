#!/usr/bin/env bash
# Готовит нативный проект Capacitor: bash scripts/prepare.sh android|ios
set -euo pipefail
PLATFORM="${1:?android или ios}"
cd "$(dirname "$0")/.."

echo "== npm install"
npm install --no-audit --no-fund
npx cap --version

if [ ! -d "$PLATFORM" ]; then
  echo "== cap add $PLATFORM"
  npx cap add "$PLATFORM"
fi
echo "== cap sync $PLATFORM"
npx cap sync "$PLATFORM"

if [ "$PLATFORM" = "android" ]; then
  M=android/app/src/main/AndroidManifest.xml
  # разрешаем http:// — сервер клуба работает без https
  grep -q usesCleartextTraffic "$M" || sed -i 's/<application/<application android:usesCleartextTraffic="true"/' "$M"
  grep -n "usesCleartextTraffic" "$M"
  # иконки
  for d in res/android/mipmap-*; do
    cp "$d"/*.png "android/app/src/main/res/$(basename "$d")/"
  done
  BGF=android/app/src/main/res/values/ic_launcher_background.xml
  if [ -f "$BGF" ]; then sed -i 's/#[0-9A-Fa-f]\{6,8\}/#0E1116/' "$BGF"; cat "$BGF"; fi
fi

if [ "$PLATFORM" = "ios" ]; then
  PL=ios/App/App/Info.plist
  PB=/usr/libexec/PlistBuddy
  # разрешаем http:// к серверу клуба (Tailscale 100.x.x.x или локальная сеть)
  $PB -c "Delete :NSAppTransportSecurity" "$PL" 2>/dev/null || true
  $PB -c "Add :NSAppTransportSecurity dict" "$PL"
  $PB -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$PL"
  $PB -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent bool true" "$PL"
  $PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PL"
  $PB -c "Delete :NSLocalNetworkUsageDescription" "$PL" 2>/dev/null || true
  $PB -c "Add :NSLocalNetworkUsageDescription string 'Подключение к серверу клуба'" "$PL"
  $PB -c "Set :CFBundleDisplayName 'Админка'" "$PL" 2>/dev/null || $PB -c "Add :CFBundleDisplayName string 'Админка'" "$PL"
  $PB -c "Print" "$PL" | head -60
  # иконка
  ICON_DIR=ios/App/App/Assets.xcassets/AppIcon.appiconset
  ls -la "$ICON_DIR"
  ICON=$(find "$ICON_DIR" -name '*.png' | head -1)
  cp res/ios/AppIcon-512@2x.png "${ICON:-$ICON_DIR/AppIcon-512@2x.png}"
fi
echo "== готово: $PLATFORM"
