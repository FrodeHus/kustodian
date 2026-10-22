#!/usr/bin/env bash
# Smoke-tests a published Kustodian executable (macOS and Linux) without opening a window:
#   1. copies it into a temp folder named "Kustodian smoke" (a path with a space);
#   2. checks that --version prints exactly "Kustodian 1.0.0";
#   3. starts it as an engine worker (--engine) the way the app's pool does, with an empty environment, sends one request
#      that evaluates `print x=1`, checks the answer, closes stdin and checks that the worker exits by itself within 5 s.
# Exits non-zero on any failure.
#
#   smoke.sh <published-executable>
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
    echo "usage: smoke.sh <published-executable>" >&2
    exit 2
fi

fail() {
    echo "smoke: FAIL: $*" >&2
    exit 1
}

work="$(mktemp -d)"
worker=""
cleanup() {
    if [[ -n "$worker" ]] && kill -0 "$worker" 2>/dev/null; then
        kill -9 "$worker" 2>/dev/null || true
    fi
    rm -rf "$work"
}
trap cleanup EXIT

dir="$work/Kustodian smoke"
mkdir "$dir"
exe="$dir/$(basename "$1")"
cp "$1" "$exe"
chmod +x "$exe"
echo "smoke: running $exe" >&2

# 2. --version
# Run in the background with a 10 s limit (no `timeout` on macOS).
"$exe" --version >"$work/version" 2>"$work/version-stderr" &
probe=$!
for _ in $(seq 100); do
    kill -0 "$probe" 2>/dev/null || break
    sleep 0.1
done
if kill -0 "$probe" 2>/dev/null; then
    kill -9 "$probe" 2>/dev/null || true
    fail "--version was still running after 10 s"
fi
status=0
wait "$probe" || status=$?
[[ "$status" -eq 0 ]] || fail "--version exited with $status; stderr: $(cat "$work/version-stderr")"
version="$(cat "$work/version")"
expected='^Kustodian 1\.0\.0$'
[[ "$version" =~ $expected ]] || fail "--version printed '$version', expected 'Kustodian 1.0.0'"
echo "smoke: --version: $version" >&2

# 3. One engine request: a 4-byte big-endian length, then that many bytes of JSON (EngineFrames, JsonSerializerDefaults.Web).
export LC_ALL=C
request='{"kql":"print x=1","now":"2026-10-20T00:00:00+00:00","tables":[],"maxRows":10}'
length=${#request}
header=""
for shift in 24 16 8 0; do
    header+="$(printf '\\%03o' $(((length >> shift) & 255)))"
done

fifo="$work/stdin"
answer="$work/answer"
mkfifo "$fifo"
# The pool starts the worker with an empty environment plus the GC heap limit (GraphEnginePool.CreateStartInfo).
env -i DOTNET_GCHeapHardLimit=0x40000000 "$exe" --engine <"$fifo" >"$answer" 2>"$work/stderr" &
worker=$!
exec 3>"$fifo"
printf '%b%s' "$header" "$request" >&3

size() { wc -c <"$answer" | tr -d ' '; }

# The first start of a single-file build extracts its native libraries, so the answer gets a generous minute.
expected_size=""
deadline=$((SECONDS + 60))
while ((SECONDS < deadline)); do
    current="$(size)"
    if [[ -z "$expected_size" && "$current" -ge 4 ]]; then
        read -r b0 b1 b2 b3 < <(od -An -tu1 -N4 "$answer")
        expected_size=$((4 + (b0 << 24 | b1 << 16 | b2 << 8 | b3)))
    fi
    if [[ -n "$expected_size" && "$current" -ge "$expected_size" ]]; then
        break
    fi
    kill -0 "$worker" 2>/dev/null || break
    sleep 0.1
done
[[ -n "$expected_size" && "$(size)" -ge "$expected_size" ]] \
    || fail "no complete answer from the engine worker; stderr: $(cat "$work/stderr")"

body="$(tail -c +5 "$answer")"
echo "smoke: engine answer: $body" >&2
for part in '"columns":[{"name":"x","type":"long"}]' '"rows":[[1]]' '"total":1' '"error":null' '"refusal":null'; do
    [[ "$body" == *"$part"* ]] || fail "the engine answer lacks $part"
done

# Closing stdin ends the worker.
exec 3>&-
for _ in $(seq 50); do
    kill -0 "$worker" 2>/dev/null || break
    sleep 0.1
done
if kill -0 "$worker" 2>/dev/null; then
    fail "the engine worker was still running 5 s after its stdin closed"
fi
status=0
wait "$worker" || status=$?
worker=""
[[ "$status" -eq 0 ]] || fail "the engine worker exited with $status; stderr: $(cat "$work/stderr")"

echo "smoke: PASS" >&2
