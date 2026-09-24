#!/usr/bin/env bash
# Local Nutshell mint(s) for the opt-in real-mint integration test (security review F6,
# execution plan §4 "real-mint testing lane"). FakeWallet Lightning backend: invoices settle at
# once and nothing real moves. Loopback only. Each start mints a fresh throwaway mint key, which
# never leaves the process environment (never printed, never written).
#
#   NUTSHELL_VENV=<venv with `cashu`> scripts/real-mint/nutshell.sh start [port] [datadir]
#   scripts/real-mint/nutshell.sh stop [port]
#
# Make the venv once (pins work around two dependency breakages in Nutshell 0.21.0's ranges):
#   uv venv <dir> --python 3.12 && uv pip install --python <dir>/bin/python \
#     cashu==0.21.0 'marshmallow<4' 'limits<4'
# Then:  NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3399 NUTFLIX_REAL_MINT_URL_2=http://127.0.0.1:3398 \
#          npx vitest run packages/core/src/__tests__/real-mint.integration.test.ts
set -euo pipefail

cmd="${1:-}"
port="${2:-3399}"
case "$port" in (*[!0-9]*|'') echo "nutshell.sh: port must be a number" >&2; exit 2;; esac

pidfile_for() { echo "${TMPDIR:-/tmp}/nutflix-nutshell-$1.pid"; }

case "$cmd" in
  start)
    : "${NUTSHELL_VENV:?set NUTSHELL_VENV to a venv with cashu==0.21.0 installed}"
    data="${3:-$(mktemp -d "${TMPDIR:-/tmp}/nutflix-nutshell-$port.XXXXXX")}"
    mkdir -p "$data" && chmod 700 "$data"
    pidfile="$(pidfile_for "$port")"
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "nutshell.sh: already running on $port" >&2; exit 1
    fi
    (
      cd "$data"
      bin="$NUTSHELL_VENV/bin/mint" # a shell variable: survives the unset loop below
      # A clean environment holding only what the mint needs. The key is EXPORTED, never passed
      # as an argument (argv is visible in the process list), and everything else is unset.
      export PATH=/usr/bin:/bin HOME="$data"
      MINT_PRIVATE_KEY="$(openssl rand -hex 32)"
      export MINT_PRIVATE_KEY MINT_BACKEND_BOLT11_SAT=FakeWallet
      export MINT_LISTEN_HOST=127.0.0.1 MINT_LISTEN_PORT="$port" MINT_DATABASE="$data/db"
      export FAKEWALLET_DELAY_INCOMING_PAYMENT=0 FAKEWALLET_DELAY_OUTGOING_PAYMENT=0
      export MINT_RATE_LIMIT=false
      while IFS= read -r v; do
        case "$v" in (PATH|HOME|MINT_*|FAKEWALLET_*) ;; (*) unset "$v" 2>/dev/null || true ;; esac
      done < <(compgen -e)
      exec setsid "$bin" >"$data/mint.log" 2>&1 </dev/null
    ) &
    echo $! >"$pidfile"
    for _ in $(seq 1 60); do
      if curl -fsS -m 2 "http://127.0.0.1:$port/v1/info" >/dev/null 2>&1; then
        echo "nutshell.sh: mint up at http://127.0.0.1:$port (data $data)"
        exit 0
      fi
      sleep 1
    done
    echo "nutshell.sh: mint did not come up; see $data/mint.log" >&2
    exit 1
    ;;
  stop)
    pidfile="$(pidfile_for "$port")"
    if [[ -f "$pidfile" ]]; then
      kill "$(cat "$pidfile")" 2>/dev/null || true
      rm -f "$pidfile"
    fi
    # The recorded PID is the mint itself: the subshell exec'd env → setsid → mint.
    echo "nutshell.sh: stopped $port"
    ;;
  *)
    echo "usage: nutshell.sh start [port] [datadir] | stop [port]" >&2
    exit 2
    ;;
esac
