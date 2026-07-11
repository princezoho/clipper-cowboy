#!/bin/bash
# Build Clipper Cowboy and install Clipper Cowboy.app on the Desktop (with logo icon).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Clipper Cowboy"
DESKTOP="${HOME}/Desktop"
APP_PATH="${DESKTOP}/${APP_NAME}.app"
APP_ICON="${REPO}/public/app-icon.png"
LOGO="${REPO}/public/logo.png"
ICONSET="${REPO}/build/AppIcon.iconset"
ICNS="${REPO}/build/AppIcon.icns"

echo "==> Building app in ${REPO}"
cd "$REPO"

echo "==> Building brand assets from logo.png"
bash "${REPO}/scripts/build-brand-assets.sh"

ICON_SRC="$APP_ICON"
if [ ! -f "$ICON_SRC" ]; then
  ICON_SRC="$LOGO"
  echo "==> No app-icon.png; using public/logo.png for Dock (run npm run build:app-icon)"
fi
if [ ! -f "$ICON_SRC" ]; then
  echo "Missing public/logo.png"
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi
npm run build

echo "==> Creating .icns from $(basename "$ICON_SRC")"
mkdir -p "${REPO}/build"
rm -rf "$ICONSET" "$ICNS"
mkdir -p "$ICONSET"

sips -z 16 16 "$ICON_SRC" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$ICON_SRC" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$ICON_SRC" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$ICON_SRC" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$ICON_SRC" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$ICON_SRC" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$ICNS"

echo "==> Packaging ${APP_PATH}"
rm -rf "$APP_PATH"
mkdir -p "${APP_PATH}/Contents/MacOS"
mkdir -p "${APP_PATH}/Contents/Resources"

cp "$ICNS" "${APP_PATH}/Contents/Resources/AppIcon.icns"
printf '%s\n' "$REPO" > "${APP_PATH}/Contents/Resources/project-root"

cat > "${APP_PATH}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.clippercowboy.desktop</string>
  <key>CFBundleName</key>
  <string>Clipper Cowboy</string>
  <key>CFBundleDisplayName</key>
  <string>Clipper Cowboy</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

cat > "${APP_PATH}/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
REPO="$(cat "$RES/project-root")"
SCRIPT="${REPO}/scripts/desktop-launch.sh"
if [ ! -x "$SCRIPT" ]; then
  osascript -e 'display alert "Clipper Cowboy" message "Project not found. Re-run package-mac-app.sh from the repo." as critical'
  exit 1
fi
osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "bash " & quoted form of "$SCRIPT"
end tell
APPLESCRIPT
LAUNCH

chmod +x "${APP_PATH}/Contents/MacOS/launch"

# Refresh Finder icon cache for this app
touch "$APP_PATH"

echo ""
echo "Done: ${APP_PATH}"
echo "Double-click it on your Desktop to start the app (opens Terminal + browser)."
echo "Project files stay in: ${REPO}"
