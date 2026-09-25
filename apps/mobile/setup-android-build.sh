#!/usr/bin/env bash
set -Eeuo pipefail

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
TOOLS_VERSION="${ITLES_ANDROID_COMMAND_LINE_TOOLS_VERSION:-16111833}"
TOOLS_DIR="$SDK_ROOT/cmdline-tools/latest"

if ! command -v javac >/dev/null 2>&1; then
  if [[ "$(id -u)" -ne 0 ]] || ! command -v apt-get >/dev/null 2>&1; then
    echo 'Install JDK 21 (or newer) with your package manager, then rerun this script.' >&2
    exit 1
  fi
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y openjdk-21-jdk-headless
fi

for tool in curl unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required command: $tool" >&2
    exit 1
  fi
done

mkdir -p "$SDK_ROOT/cmdline-tools"
if [[ ! -x "$TOOLS_DIR/bin/sdkmanager" ]]; then
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -fL --retry 3 \
    "https://dl.google.com/android/repository/commandlinetools-linux-${TOOLS_VERSION}_latest.zip" \
    -o "$TMP_DIR/commandlinetools.zip"
  unzip -q "$TMP_DIR/commandlinetools.zip" -d "$TMP_DIR/unpacked"
  rm -rf "$TOOLS_DIR"
  mv "$TMP_DIR/unpacked/cmdline-tools" "$TOOLS_DIR"
fi

export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
"$TOOLS_DIR/bin/sdkmanager" --sdk_root="$SDK_ROOT" \
  'platforms;android-36' 'build-tools;36.0.0'

printf 'JDK: %s\n' "$(javac -version 2>&1)"
printf 'Android SDK: %s\n' "$SDK_ROOT"

