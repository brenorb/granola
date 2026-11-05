#!/usr/bin/env bash
# Local production-like QA stack for Granola. Nothing here contacts public
# relays or mints: Chromium maps the production hostnames to a local TLS proxy.
#
#   scripts/qa/stack.sh tools      # build relay, install Nutshell + cdk-mintd (once)
#   scripts/qa/stack.sh start      # certs, mints, relays, proxy (serves dist/)
#   scripts/qa/stack.sh seed       # wipe relays, seed 1,200 open + 400 canceled orders, snapshot
#   scripts/qa/stack.sh reset      # restore relays to the seeded snapshot
#   scripts/qa/stack.sh relays [filter|closed]   # restart relays; inbox denial style
#   scripts/qa/stack.sh stop
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
QA="$REPO/scripts/qa"
ROOT="${QA_ROOT:-/tmp/granola-qa}"
export QA_ROOT="$ROOT"
mkdir -p "$ROOT/logs" "$ROOT/data"

# Public BIP39 test vector; local QA mint only, never a real wallet.
TEST_MNEMONIC="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
RELAY_MAP="wss://nos.lol=ws://127.0.0.1:7001,wss://relay.primal.net=ws://127.0.0.1:7002,wss://offchain.pub=ws://127.0.0.1:7003"

tools() {
  (cd "$QA/relay" && go build -o "$ROOT/relay" .)
  uv venv -q -p python3.12 "$ROOT/nutshell"
  # Nutshell 0.20.2 needs these older transitive versions.
  VIRTUAL_ENV="$ROOT/nutshell" uv pip install -q "cashu==0.20.2" "marshmallow<4" "limits<4"
  command -v protoc >/dev/null || { echo "cdk-mintd needs protoc (apt-get install protobuf-compiler)"; exit 1; }
  cargo install cdk-mintd --version 0.18.3 --locked --root "$ROOT/cdk"
}

certs() {
  [ -f "$ROOT/tls/cert.pem" ] && return
  mkdir -p "$ROOT/tls"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=granola-qa" \
    -keyout "$ROOT/tls/key.pem" -out "$ROOT/tls/cert.pem" \
    -addext "subjectAltName=DNS:brenorb.com,DNS:testnut.cashu.space,DNS:testnut.cashudevkit.org,DNS:nos.lol,DNS:relay.primal.net,DNS:offchain.pub,DNS:auth.nostr1.com" 2>/dev/null
}

relays() {
  local deny="${1:-filter}"
  pkill -f "$ROOT/relay -addr" || true
  sleep 0.5
  local spec
  for spec in "7001 wss://nos.lol" "7002 wss://relay.primal.net" "7003 wss://offchain.pub"; do
    set -- $spec
    nohup "$ROOT/relay" -addr "127.0.0.1:$1" -url "$2" -db "$ROOT/data/relay-$1" >"$ROOT/logs/relay-$1.log" 2>&1 &
  done
  nohup "$ROOT/relay" -addr 127.0.0.1:7004 -url wss://auth.nostr1.com -db "$ROOT/data/relay-7004" \
    -auth -deny "$deny" >"$ROOT/logs/relay-7004.log" 2>&1 &
  sleep 1
}

mints() {
  mkdir -p "$ROOT/mint-space/data" "$ROOT/mint-cdk"
  cp "$QA/mints/nutshell.env" "$ROOT/mint-space/.env"
  (cd "$ROOT/mint-space" && nohup "$ROOT/nutshell/bin/mint" >"$ROOT/logs/mint-space.log" 2>&1 &)
  export CDK_MINTD_MNEMONIC="$TEST_MNEMONIC"
  if [ ! -f "$ROOT/mint-cdk/.initialized" ]; then
    "$ROOT/cdk/bin/cdk-mintd" -w "$ROOT/mint-cdk" config init --file "$QA/mints/cdk-config.toml" --new-mint
    touch "$ROOT/mint-cdk/.initialized"
  fi
  nohup "$ROOT/cdk/bin/cdk-mintd" -w "$ROOT/mint-cdk" >"$ROOT/logs/mint-cdk.log" 2>&1 &
}

case "${1:-}" in
  tools) tools ;;
  start)
    certs
    (cd "$REPO" && npm run build >/dev/null)
    mints
    relays filter
    nohup node "$QA/proxy.mjs" >"$ROOT/logs/proxy.log" 2>&1 &
    sleep 5
    curl -sf --noproxy '*' http://127.0.0.1:3338/v1/info >/dev/null && echo "SAT mint up"
    curl -sf --noproxy '*' http://127.0.0.1:3339/v1/info >/dev/null && echo "USD mint up"
    ;;
  relays) relays "${2:-filter}" ;;
  seed)
    pkill -f "$ROOT/relay -addr" || true
    rm -rf "$ROOT"/data/relay-700*
    relays filter
    (cd "$REPO" && QA_RELAY_MAP="$RELAY_MAP" npx tsx scripts/qa/seed-local-orderbook.ts)
    pkill -f "$ROOT/relay -addr" || true
    sleep 1
    rm -rf "$ROOT/seed-snapshot" && mkdir -p "$ROOT/seed-snapshot"
    cp -r "$ROOT"/data/relay-700* "$ROOT/seed-snapshot/"
    relays filter
    ;;
  reset)
    pkill -f "$ROOT/relay -addr" || true
    sleep 1
    rm -rf "$ROOT"/data/relay-700*
    cp -r "$ROOT"/seed-snapshot/relay-700* "$ROOT/data/"
    relays "${2:-filter}"
    ;;
  stop)
    pkill -f "$ROOT/relay -addr" || true
    pkill -f "$QA/proxy.mjs" || true
    pkill -f "$ROOT/nutshell/bin/mint" || true
    pkill -f "$ROOT/cdk/bin/cdk-mintd" || true
    ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
