#!/usr/bin/env bash
# Builds small single-file executables of RoaDo Optimizer into dist/.
# Needs Go 1.22+ on PATH (or GO=/path/to/go ./build.sh).
set -euo pipefail
cd "$(dirname "$0")"
GO="${GO:-go}"

# 1) stage the web app inside the launcher (index.html plain, everything else pre-gzipped)
rm -rf launcher/web && mkdir -p launcher/web
cp index.html launcher/web/
for f in css/*.css js/*.js vendor/*.js; do
  mkdir -p "launcher/web/$(dirname "$f")"
  gzip -9 -n -c "$f" > "launcher/web/$f.gz"
done

# 2) build for each platform (stripped, no debug info)
mkdir -p dist
cd launcher
build() { # os arch output [extra ldflags]
  echo "building $3"
  CGO_ENABLED=0 GOOS=$1 GOARCH=$2 "$GO" build -trimpath -ldflags "-s -w ${4:-}" -o "../dist/$3" .
}
build linux   amd64 roado-optimizer-linux
build windows amd64 roado-optimizer-windows.exe "-H windowsgui"
build darwin  arm64 roado-optimizer-macos-arm64
cd ..
rm -rf launcher/web
ls -lh dist
