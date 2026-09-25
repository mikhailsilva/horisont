#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$APP_DIR/../.." && pwd -P)"
cd "$APP_DIR"

npm ci

pnpm --dir "$REPO_ROOT/platform" install --frozen-lockfile
pnpm --dir "$REPO_ROOT/platform" build:ui

npm run prepare-web

if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_BIN="$(command -v java || true)"
  if [[ -z "$JAVA_BIN" ]]; then
    echo 'Java was not found; install JDK 17 or newer and set JAVA_HOME.' >&2
    exit 1
  fi
  JAVA_HOME="$(dirname -- "$(dirname -- "$(readlink -f -- "$JAVA_BIN")")")"
fi
if [[ ! -x "$JAVA_HOME/bin/java" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "JAVA_HOME must point to a JDK: $JAVA_HOME" >&2
  exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
export ANDROID_SDK_ROOT
export ANDROID_HOME="$ANDROID_SDK_ROOT"
BUILD_TOOLS_VERSION="${ITLES_ANDROID_BUILD_TOOLS_VERSION:-36.0.0}"
BUILD_TOOLS="$ANDROID_SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION"
for tool in zipalign apksigner aapt; do
  if [[ ! -x "$BUILD_TOOLS/$tool" ]]; then
    echo "Missing $BUILD_TOOLS/$tool; install build-tools;$BUILD_TOOLS_VERSION in $ANDROID_SDK_ROOT." >&2
    exit 1
  fi
done
if [[ ! -d "$ANDROID_SDK_ROOT/platforms/android-36" ]]; then
  echo "Missing $ANDROID_SDK_ROOT/platforms/android-36; install platform android-36." >&2
  exit 1
fi

npx cap sync android
KEYSTORE="${ITLES_KEYSTORE:-/opt/itles-keystore/itles-release.jks}"
case "$KEYSTORE" in
  /*) ;;
  *) KEYSTORE="$PWD/$KEYSTORE" ;;
esac
KEYSTORE="$(python3 - "$KEYSTORE" <<'PY'
from pathlib import Path
import sys

print(Path(sys.argv[1]).resolve(strict=False))
PY
)"
case "$KEYSTORE" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo 'ITLES_KEYSTORE must be outside the repository.' >&2
    exit 1
    ;;
esac
PASSWORD_FILE="${KEYSTORE}.password"
KEY_ALIAS='itles-release'
OUTPUT_DIR="$APP_DIR/dist"
mkdir -p "$OUTPUT_DIR"
chmod 755 "$OUTPUT_DIR"

if [[ -f "$KEYSTORE" && -f "$PASSWORD_FILE" ]]; then
  ./android/gradlew --no-daemon --project-dir android :app:assembleRelease
  UNSIGNED_APK="$APP_DIR/android/app/build/outputs/apk/release/app-release-unsigned.apk"
  if [[ ! -f "$UNSIGNED_APK" ]]; then
    echo "Gradle did not produce $UNSIGNED_APK" >&2
    exit 1
  fi
  chmod 600 "$PASSWORD_FILE"
  APK_BUILD_DIR="$APP_DIR/android/app/build/outputs/apk/release"
  ALIGNED_APK="$APK_BUILD_DIR/itles-aligned.apk"
  SIGNED_APK="$APK_BUILD_DIR/itles-signed.apk"
  OUTPUT_APK="$OUTPUT_DIR/itles-android.apk"
  "$BUILD_TOOLS/zipalign" -f -p 4 "$UNSIGNED_APK" "$ALIGNED_APK"
  "$BUILD_TOOLS/zipalign" -c -p 4 "$ALIGNED_APK"
  "$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" \
    --ks-key-alias "$KEY_ALIAS" \
    --ks-pass "file:$PASSWORD_FILE" \
    --out "$SIGNED_APK" \
    "$ALIGNED_APK"
  "$BUILD_TOOLS/apksigner" verify --verbose --print-certs "$SIGNED_APK"
  mv -- "$SIGNED_APK" "$OUTPUT_APK"
elif [[ "${ITLES_ANDROID_BUILD_TYPE:-release}" == debug ]]; then
  echo 'ITLES_ANDROID_BUILD_TYPE=debug; building a debug APK. This APK cannot update installs signed with the release key.' >&2
  ./android/gradlew --no-daemon --project-dir android :app:assembleDebug
  DEBUG_APK="$APP_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
  if [[ ! -f "$DEBUG_APK" ]]; then
    echo "Gradle did not produce $DEBUG_APK" >&2
    exit 1
  fi
  OUTPUT_APK="$OUTPUT_DIR/itles-android-debug.apk"
  cp -- "$DEBUG_APK" "$OUTPUT_APK"
  "$BUILD_TOOLS/apksigner" verify --verbose --print-certs "$OUTPUT_APK"
else
  echo "Release signing key/password not found. Set ITLES_KEYSTORE and its .password file, or explicitly opt in to a non-update-compatible debug APK with ITLES_ANDROID_BUILD_TYPE=debug." >&2
  exit 1
fi

chmod 644 "$OUTPUT_APK"
printf '\nAPK: %s\n' "$OUTPUT_APK"
printf 'SHA-256: '
sha256sum "$OUTPUT_APK"
printf 'Size: '
du -h "$OUTPUT_APK" | cut -f1
