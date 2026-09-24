#!/usr/bin/env bash
# Local cdk-mintd for the opt-in real-mint integration tests — the second Cashu mint
# implementation F6 asked for (security review §0a). FakeWallet backend, loopback only, a real
# 100 ppk input fee. Each start makes a fresh throwaway mnemonic that lives only in the process
# environment (never printed, never written to the config).
#
#   CDK_MINTD_BIN=<path to cdk-mintd> MNEMONIC_PYTHON=<python with `mnemonic`> \
#     scripts/real-mint/cdk-mintd.sh start [port] [workdir]
#   scripts/real-mint/cdk-mintd.sh stop [port]
#
# Build once:  PROTOC=<protoc> cargo install cdk-mintd --version 0.18.1 --locked --root <dir>
# (the Nutshell venv from nutshell.sh has `mnemonic`; any python with it works).
set -euo pipefail

cmd="${1:-}"
port="${2:-3397}"
case "$port" in (*[!0-9]*|'') echo "cdk-mintd.sh: port must be a number" >&2; exit 2;; esac
pidfile="${TMPDIR:-/tmp}/nutflix-cdk-mintd-$port.pid"

case "$cmd" in
  start)
    : "${CDK_MINTD_BIN:?set CDK_MINTD_BIN to the cdk-mintd binary}"
    : "${MNEMONIC_PYTHON:?set MNEMONIC_PYTHON to a python with the mnemonic package}"
    work="${3:-$(mktemp -d "${TMPDIR:-/tmp}/nutflix-cdk-mintd-$port.XXXXXX")}"
    mkdir -p "$work" && chmod 700 "$work"
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "cdk-mintd.sh: already running on $port" >&2; exit 1
    fi
    cat >"$work/config.toml" <<TOML
[info]
url = "http://127.0.0.1:$port/"
listen_host = "127.0.0.1"
listen_port = $port
mnemonic = "env:CDK_MINTD_MNEMONIC"
input_fee_ppk = 100

[database]
engine = "sqlite"

[payment_backend]
backend = "fakewallet"

[fake_wallet]
fee_percent = 0.02
reserve_fee_min = 1
custom_payment_methods = []
TOML
    (
      # The mnemonic exists only in this subshell's environment and the mint's.
      CDK_MINTD_MNEMONIC="$("$MNEMONIC_PYTHON" -c 'from mnemonic import Mnemonic; print(Mnemonic("english").generate(128))')"
      export CDK_MINTD_MNEMONIC
      "$CDK_MINTD_BIN" --work-dir "$work" config init --file "$work/config.toml" --new-mint >/dev/null
      exec setsid "$CDK_MINTD_BIN" --work-dir "$work" --enable-logging >"$work/mint.log" 2>&1 </dev/null
    ) &
    echo $! >"$pidfile"
    for _ in $(seq 1 60); do
      if curl -fsS -m 2 "http://127.0.0.1:$port/v1/info" >/dev/null 2>&1; then
        echo "cdk-mintd.sh: mint up at http://127.0.0.1:$port (work dir $work)"
        exit 0
      fi
      sleep 1
    done
    echo "cdk-mintd.sh: mint did not come up; see $work/mint.log" >&2
    exit 1
    ;;
  stop)
    if [[ -f "$pidfile" ]]; then
      kill "$(cat "$pidfile")" 2>/dev/null || true
      rm -f "$pidfile"
    fi
    echo "cdk-mintd.sh: stopped $port"
    ;;
  *)
    echo "usage: cdk-mintd.sh start [port] [workdir] | stop [port]" >&2
    exit 2
    ;;
esac
