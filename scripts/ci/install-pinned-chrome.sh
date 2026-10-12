#!/usr/bin/env bash
# Install the Google Chrome stable .deb named by CHROME_VERSION and refuse any other build.
set -euo pipefail

: "${CHROME_VERSION:?CHROME_VERSION is required}"
: "${CHROME_DEB_SHA256:?CHROME_DEB_SHA256 is required}"

deb="google-chrome-stable_${CHROME_VERSION}-1_amd64.deb"
url="https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/${deb}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"

curl -fsSL -o "$deb" "$url"
printf '%s  %s\n' "$CHROME_DEB_SHA256" "$deb" | sha256sum -c -

# The runner image may already have a different Chrome; allow this pin to replace it.
sudo DEBIAN_FRONTEND=noninteractive apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "./${deb}"

version_output="$(/opt/google/chrome/chrome --version)"
version_output="${version_output//$'\r'/}"
version_output="${version_output#"${version_output%%[![:space:]]*}"}"
version_output="${version_output%"${version_output##*[![:space:]]}"}"

expected="Google Chrome ${CHROME_VERSION}"
if [[ "$version_output" != "$expected" ]]; then
  printf 'pinned Chrome check failed: expected %q, got %q\n' "$expected" "$version_output" >&2
  exit 1
fi

printf '%s\n' "$version_output"
