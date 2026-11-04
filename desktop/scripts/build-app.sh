#!/usr/bin/env bash
# Builds Vaani.app from the Swift package and zips it. macOS only.
#
#   scripts/build-app.sh                 # Apple Silicon (arm64), ad-hoc signed
#   ARCH=universal scripts/build-app.sh  # arm64 + x86_64
#   SIGN_IDENTITY="Developer ID Application: ..." scripts/build-app.sh
#
# Output: build/Vaani.app and build/Vaani-macOS-<arch>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-app.sh needs macOS (it uses codesign, plutil and ditto)." >&2
  exit 1
fi

ARCH="${ARCH:-arm64}"
OUT="${OUT:-build}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"   # "-" = ad-hoc (unsigned for Gatekeeper)
APP="$OUT/Vaani.app"

echo "==> swift build (release, $ARCH)"
if [[ "$ARCH" == "universal" ]]; then
  swift build -c release --arch arm64 --arch x86_64
  BIN_DIR="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"
else
  swift build -c release --arch "$ARCH"
  BIN_DIR="$(swift build -c release --arch "$ARCH" --show-bin-path)"
fi

echo "==> assemble $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Vaani" "$APP/Contents/MacOS/Vaani"
cp Resources/Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if [[ -f Resources/AppIcon.icns ]]; then
  cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
  plutil -replace CFBundleIconFile -string AppIcon "$APP/Contents/Info.plist"
fi
plutil -lint "$APP/Contents/Info.plist"

echo "==> check required Info.plist keys"
for key in NSMicrophoneUsageDescription NSAudioCaptureUsageDescription LSUIElement LSMinimumSystemVersion CFBundleIdentifier; do
  plutil -extract "$key" raw "$APP/Contents/Info.plist" >/dev/null || { echo "missing $key" >&2; exit 1; }
done

echo "==> codesign (identity: $SIGN_IDENTITY, hardened runtime)"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  codesign --force --options runtime --entitlements Resources/Vaani.entitlements --sign - --timestamp=none "$APP"
else
  codesign --force --options runtime --entitlements Resources/Vaani.entitlements --sign "$SIGN_IDENTITY" --timestamp "$APP"
fi
codesign --verify --strict --verbose=2 "$APP"

echo "==> check entitlements are exactly audio-input"
ENT="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null)"
echo "$ENT" | grep -q "com.apple.security.device.audio-input" || { echo "audio-input entitlement missing" >&2; exit 1; }
COUNT="$(echo "$ENT" | grep -o '<key>com\.apple\.[^<]*</key>' | wc -l | tr -d ' ')"
[[ "$COUNT" == "1" ]] || { echo "unexpected extra entitlements:"; echo "$ENT"; exit 1; } >&2

echo "==> zip"
ZIP="$OUT/Vaani-macOS-$ARCH.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "Built $APP and $ZIP"
