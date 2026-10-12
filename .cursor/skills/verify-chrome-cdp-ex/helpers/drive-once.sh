#!/usr/bin/env bash
# Usage: drive-once.sh [repo] [evidence-dir]
# Walk the user path once on an isolated headless Chrome.
# repo defaults to the git toplevel. evidence-dir defaults to /tmp/cdp-ev-<epoch>.
set -u

REPO="${1:-$(git rev-parse --show-toplevel)}"
EV="${2:-/tmp/cdp-ev-$(date +%s)}"
mkdir -p "$EV"

PORT="${CDP_VERIFY_PORT:-9444}"
if curl -s -m1 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
  echo "port ${PORT} is in use; set CDP_VERIFY_PORT"
  exit 2
fi

PROF="$(mktemp -d /tmp/cdp-verify-prof-XXXX)"
export CDP_RUNTIME_DIR="${PROF}/runtime"
mkdir -p "$CDP_RUNTIME_DIR"

PAGE="${PROF}/page.html"
if [[ "${CDP_VERIFY_NO_ONCLICK:-}" == "1" ]]; then
  cat >"$PAGE" <<'H'
<!doctype html><title>verify</title><button id=b aria-pressed=false>Toggle me</button><p id=o>idle</p>
H
else
  cat >"$PAGE" <<'H'
<!doctype html><title>verify</title><button id=b aria-pressed=false onclick="this.setAttribute('aria-pressed','true');document.getElementById('o').textContent='clicked'">Toggle me</button><p id=o>idle</p>
H
fi

HPORT="${CDP_VERIFY_HTTP_PORT:-41744}"
( cd "$PROF" && exec python3 -m http.server --bind 127.0.0.1 "$HPORT" ) >"$EV/http.log" 2>&1 &
HPID=$!

# Chrome treats a bare --user-data-dir as the default profile. Keep the equals form.
CHROME="${CHROME_BIN:-google-chrome}"
"$CHROME" --headless=new --no-sandbox \
  --remote-debugging-port="$PORT" \
  --user-data-dir="${PROF}/chrome" \
  about:blank >"$EV/chrome.log" 2>&1 &
CPID=$!

# Descendants only. Never match a process by name.
kill_tree() {
  local pid="$1"
  local child
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  if [[ -r "/proc/${pid}/task/${pid}/children" ]]; then
    for child in $(<"/proc/${pid}/task/${pid}/children"); do
      kill_tree "$child"
    done
  fi
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  local attempt
  if cd "$REPO"; then
    CDP_PORT="$PORT" ./bin/chrome-cdp stop >/dev/null 2>&1 || true
  fi
  kill_tree "$HPID"
  kill_tree "$CPID"
  wait "$CPID" 2>/dev/null || true
  # The profile stays busy for a moment after Chrome exits.
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if rm -rf "$PROF" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  rm -rf "$PROF" || true
}
trap cleanup EXIT

for _ in $(seq 30); do
  if curl -s -m1 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
    break
  fi
  sleep 0.5
done

cd "$REPO"
export CDP_PORT="$PORT"
export CDP_ISOLATED_ONLY=1

fails=0
run() {
  echo "\$ chrome-cdp $*" | tee -a "$EV/transcript.txt"
  local out rc
  out="$(mktemp)"
  ./bin/chrome-cdp "$@" >"$out" 2>&1
  rc=$?
  cat "$out" >>"$EV/transcript.txt"
  tail -n 2 "$out"
  rm -f "$out"
  echo "[exit ${rc}]" | tee -a "$EV/transcript.txt"
  if [[ "$rc" -ne 0 ]]; then
    fails=$((fails + 1))
  fi
}

run doctor
# file: URLs are refused on purpose. Serve the page over http.
run open "http://127.0.0.1:${HPORT}/page.html"
T="$(./bin/chrome-cdp list 2>/dev/null | grep -i verify | awk '{print $1}' | head -n 1)"
echo "target=${T}" | tee -a "$EV/transcript.txt"
if [[ -z "$T" ]]; then
  fails=$((fails + 1))
fi
run perceive "$T" -C -d 8
run click "$T" "#b"
run eval "$T" "document.getElementById('o').textContent + ' ' + document.getElementById('b').getAttribute('aria-pressed')"
run shot "$T" "$EV/after-click.png"
echo "evidence: ${EV}"
echo "failed steps: ${fails}"
if [[ "$fails" -gt 0 ]]; then
  exit 1
fi
exit 0
