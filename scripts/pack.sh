#!/bin/sh
# אורז את התוסף ל-ZIP להעלאה לחנות של כרום: רק הקבצים שהתוסף צריך, בלי שרת, בדיקות ותיעוד.
set -e
cd "$(dirname "$0")/.."
VER=$(node -p "require('./manifest.json').version")
OUT="dist/metzion-$VER.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr "$OUT" manifest.json src options icons -x '*.DS_Store'
echo "$OUT"
