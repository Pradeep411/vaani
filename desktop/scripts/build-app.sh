#!/usr/bin/env bash
# Builds Vaani.app from the Swift package and zips it. macOS only.
#
#   bash scripts/build-app.sh                    # Apple Silicon, App Sandbox ON, ad-hoc signed
#   SANDBOX=0 bash scripts/build-app.sh          # DIAGNOSTIC: sandbox off, never signed, never handed out
#
# SANDBOX must be exactly 1 or 0. The diagnostic build (0) is a different app:
# bundle ID io.github.pradeep411.vaani.desktop.diagnostic, name
# "Vaani DIAGNOSTIC", bundle Vaani-DIAGNOSTIC-no-sandbox.app, a
# VaaniDiagnosticBuild=true key (runtime banner, no login item, no stored web
# data), and it can only be ad-hoc signed (security re-audit D-01).
#   ARCH=universal bash scripts/build-app.sh     # arm64 + x86_64
#   SIGN_IDENTITY="Developer ID Application: ..." bash scripts/build-app.sh
#
# Output: $OUT/Vaani.app and $OUT/Vaani-macOS-<arch>[-NOSANDBOX-diagnostic].zip
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-app.sh needs macOS (it uses codesign, plutil and ditto)." >&2
  exit 1
fi

ARCH="${ARCH:-arm64}"
SANDBOX="${SANDBOX:-1}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"   # "-" = ad-hoc (unsigned for Gatekeeper)
case "$SANDBOX" in
  1)
    OUT="${OUT:-build}"
    ENTITLEMENTS="Resources/Vaani.entitlements"
    EXPECTED_KEYS="com.apple.security.app-sandbox com.apple.security.device.audio-input com.apple.security.files.user-selected.read-write com.apple.security.network.client"
    ZIP_SUFFIX=""
    APP_NAME="Vaani.app"
    ;;
  0)
    if [[ "$SIGN_IDENTITY" != "-" ]]; then
      echo "Refusing to sign the diagnostic (SANDBOX=0) build with a real identity." >&2
      exit 1
    fi
    OUT="${OUT:-build-nosandbox}"
    ENTITLEMENTS="Resources/Vaani-nosandbox.entitlements"
    EXPECTED_KEYS="com.apple.security.device.audio-input"
    ZIP_SUFFIX="-NOSANDBOX-diagnostic"
    APP_NAME="Vaani-DIAGNOSTIC-no-sandbox.app"
    ;;
  *)
    echo "SANDBOX must be exactly 1 (normal) or 0 (diagnostic), not '$SANDBOX'." >&2
    exit 1
    ;;
esac
APP="$OUT/$APP_NAME"

echo "==> swift build (release, $ARCH)"
if [[ "$ARCH" == "universal" ]]; then
  swift build -c release --arch arm64 --arch x86_64
  BIN_DIR="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"
else
  swift build -c release --arch "$ARCH"
  BIN_DIR="$(swift build -c release --arch "$ARCH" --show-bin-path)"
fi

echo "==> assemble $APP (sandbox: $SANDBOX)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Vaani" "$APP/Contents/MacOS/Vaani"
cp Resources/Info.plist "$APP/Contents/Info.plist"
# The bridge's document-start script. Without it the bridge stays closed.
cp Resources/vaani-userscript.js "$APP/Contents/Resources/vaani-userscript.js"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if [[ -f Resources/AppIcon.icns ]]; then
  cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
  plutil -replace CFBundleIconFile -string AppIcon "$APP/Contents/Info.plist"
fi
if [[ "$SANDBOX" == "0" ]]; then
  # A different app: different ID and name, flagged for the runtime banner.
  plutil -replace CFBundleIdentifier -string "io.github.pradeep411.vaani.desktop.diagnostic" "$APP/Contents/Info.plist"
  plutil -replace CFBundleName -string "Vaani DIAGNOSTIC" "$APP/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string "Vaani DIAGNOSTIC" "$APP/Contents/Info.plist"
  plutil -replace VaaniDiagnosticBuild -bool true "$APP/Contents/Info.plist"
else
  # The normal app must never carry the diagnostic flag.
  if plutil -extract VaaniDiagnosticBuild raw "$APP/Contents/Info.plist" >/dev/null 2>&1; then
    echo "VaaniDiagnosticBuild must not be in the normal Info.plist" >&2; exit 1
  fi
fi
plutil -lint "$APP/Contents/Info.plist"

echo "==> check required Info.plist keys"
for key in NSMicrophoneUsageDescription NSAudioCaptureUsageDescription LSUIElement LSMinimumSystemVersion CFBundleIdentifier; do
  plutil -extract "$key" raw "$APP/Contents/Info.plist" >/dev/null || { echo "missing $key" >&2; exit 1; }
done

echo "==> codesign (identity: $SIGN_IDENTITY, hardened runtime, $ENTITLEMENTS)"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - --timestamp=none "$APP"
else
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" --timestamp "$APP"
fi
codesign --verify --strict --verbose=2 "$APP"

echo "==> check entitlements are exactly the allow-list"
ENT="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null)"
ACTUAL="$(echo "$ENT" | grep -o '<key>[^<]*</key>' | sed -e 's#<key>##' -e 's#</key>##' | sort | tr '\n' ' ' | sed 's/ $//')"
WANT="$(echo "$EXPECTED_KEYS" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')"
if [[ "$ACTUAL" != "$WANT" ]]; then
  echo "entitlements differ from the allow-list" >&2
  echo "  want: $WANT" >&2
  echo "  have: $ACTUAL" >&2
  exit 1
fi

echo "==> zip"
ZIP="$OUT/Vaani-macOS-$ARCH$ZIP_SUFFIX.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
shasum -a 256 "$ZIP" | tee "$ZIP.sha256"
echo "Built $APP and $ZIP"
