#!/usr/bin/env bash
# S3 Linux scenario WITH a secret service: dbus session + gnome-keyring-daemon unlocked with an empty test password.
# Run inside node:22-bookworm-slim after: apt-get install -y dbus gnome-keyring  (and the spike package installed).
# Usage: dbus-run-session -- bash /spike/linux/run-withsecret.sh
set -u
t() { local s e; s=$(date +%s%N); timeout 40 "$@"; local rc=$?; e=$(date +%s%N); echo "    -> exit=$rc wall=$(( (e-s)/1000000 ))ms"; }
CLI=prosegate-spike
export HOME=${HOME:-/root}
GDB="gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets"
# gnome-keyring 42.1 headless: --unlock with an empty password does NOT create a login keyring (dir stays empty,
# alias "default" = "/"), and keyring-rs writes to the "default" alias. Workaround: point "default" at the
# in-memory, always-unlocked "session" collection. API path is identical; storage is not persistent.
setup_ss() {
  printf "" | gnome-keyring-daemon --unlock --replace --components=secrets >/dev/null 2>&1
  eval "$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)"; sleep 0.3
  $GDB --method org.freedesktop.Secret.Service.SetAlias default /org/freedesktop/secrets/collection/session >/dev/null && echo "  (alias default -> collection/session)"
}

echo "## G0. gnome-keyring-daemon running but NOT unlocked (no login collection yet)"
eval "$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)"
sleep 0.3
echo "  set --async --timeout 5000 (default store)"; t $CLI set --async --timeout 5000
echo "  get --async --timeout 5000"; t $CLI get --async --timeout 5000
echo "  delete --async --timeout 5000"; t $CLI delete --async --timeout 5000
pkill -f gnome-keyring-daemon; sleep 0.3; rm -rf "$HOME/.local/share/keyrings"

echo; echo "## G. gnome-keyring-daemon unlocked with empty password"
setup_ss
echo "  roundtrip (default store)"; t $CLI roundtrip
echo "  set / get / delete / getafterdelete as separate processes (secret-service pinned)"
for c in set get delete getafterdelete; do echo "  $c"; SPIKE_STORE=secret-service t $CLI $c; done
echo "  seterr 200 (Q5: does the error echo the value?)"; t $CLI seterr 200

echo; echo "## H. Latency, 20 fresh processes (bench script, secret-service pinned)"
SPIKE_STORE=secret-service node /spike/bench-windows.mjs 20 "$(npm root -g)/prosegate-spike/dist/cli.js" | tail -13

echo; echo "## I. Locked collection (after 'lock'): what happens on get?"
SPIKE_STORE=secret-service $CLI set >/dev/null
# Lock all collections via the Secret Service API using gdbus if available, else skip.
if command -v gdbus >/dev/null; then
  gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets \
    --method org.freedesktop.Secret.Service.Lock "['/org/freedesktop/secrets/collection/session']" && echo "  locked session collection"
  echo "  get --async --timeout 5000 on locked collection"; SPIKE_STORE=secret-service t $CLI get --async --timeout 5000
  echo "  get sync on locked collection (timeout 40 s outer)"; SPIKE_STORE=secret-service t $CLI get
  setup_ss
fi
echo "  cleanup delete"; SPIKE_STORE=secret-service t $CLI delete
echo "  confirm absent"; SPIKE_STORE=secret-service t $CLI getafterdelete

echo; echo "## J. Secret Service daemon frozen (SIGSTOP): real D-Bus, provider never replies"
export KEYRING_MOD=$(npm root -g)/prosegate-spike/node_modules/@napi-rs/keyring
SPIKE_STORE=secret-service $CLI set >/dev/null
GKD=$(pgrep -f gnome-keyring-daemon | head -1); kill -STOP $GKD; echo "  froze gnome-keyring-daemon pid=$GKD"
echo "  unguarded sync get (secret-service)"; SPIKE_STORE=secret-service t $CLI get
echo "  unguarded sync get (default store)"; t $CLI get
echo "  --async --timeout 1500"; t $CLI get --async --timeout 1500
for m in worker worker-reallyexit worker-sigkill child; do echo "  guard-test $m 1500"; t node /spike/linux/guard-test.cjs $m 1500; done
kill -CONT $GKD; echo "  resumed daemon"
echo "  cleanup delete"; SPIKE_STORE=secret-service t $CLI delete
echo "  confirm absent"; SPIKE_STORE=secret-service t $CLI getafterdelete
