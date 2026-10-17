#!/usr/bin/env bash
# S3 Linux scenarios WITHOUT a working secret service. Run inside node:22-bookworm-slim with /spike mounted.
# Dummy value only; service `prosegate-spike`.
set -u
CLI=prosegate-spike
t() { local s e; s=$(date +%s%N); timeout 40 "$@"; local rc=$?; e=$(date +%s%N); echo "    -> exit=$rc wall=$(( (e-s)/1000000 ))ms"; }

echo "== env: $(node -v) $(uname -r) glibc=$(ldd --version | head -1 | awk '{print $NF}') CI=${CI:-unset} DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unset}"
NODEF=$(find "$(npm root -g)/prosegate-spike" -name '*.node' | head -1)
echo "== native binary: ${NODEF#$(npm root -g)/}"
echo "== ldd of native binary:"; ldd "$NODEF" | sed 's/ (0x.*//; s/^/    /'
echo "== seccomp: $(grep Seccomp: /proc/self/status | tr -s '\t' ' ')"

echo; echo "## A. No D-Bus at all, default store (auto: secret-service then keyutils)"
for c in set get delete; do echo "  $c"; t $CLI $c; done
echo "  get --async"; t $CLI get --async

echo; echo "## B. No D-Bus, store pinned to secret-service"
for c in set get delete; do echo "  $c"; SPIKE_STORE=secret-service t $CLI $c; done

echo; echo "## C. No D-Bus, store pinned to keyutils"
for c in set get delete; do echo "  $c"; SPIKE_STORE=keyutils t $CLI $c; done

echo; echo "## D. DBUS_SESSION_BUS_ADDRESS points to a missing socket (stale SSH env)"
for c in set get; do echo "  $c (default)"; DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/nope.sock t $CLI $c; done
echo "  set (secret-service)"; DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/nope.sock SPIKE_STORE=secret-service t $CLI set
echo "  delete (default, cleanup)"; DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/nope.sock t $CLI delete

echo; echo "## E. D-Bus socket that accepts and never answers (hung daemon)"
node /spike/linux/stall-dbus.cjs /tmp/stall.sock & STALL=$!
sleep 0.5
echo "  get sync, default store, no guard"; DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/stall.sock t $CLI get
echo "  get sync, secret-service, no guard"; DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/stall.sock SPIKE_STORE=secret-service t $CLI get
echo "  get sync with --timeout 1500 (guard cannot fire: event loop blocked)"; DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/stall.sock t $CLI get --timeout 1500
echo "  get --async with --timeout 1500 (guard on event loop)"; DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/stall.sock t $CLI get --async --timeout 1500
kill $STALL 2>/dev/null

echo; echo "## F. D-Bus session bus running, but no secret service provider installed"
if command -v dbus-run-session >/dev/null; then
  dbus-run-session -- bash -c '
    t() { local s e; s=$(date +%s%N); timeout 40 "$@"; local rc=$?; e=$(date +%s%N); echo "    -> exit=$rc wall=$(( (e-s)/1000000 ))ms"; }
    echo "  set (default)"; t prosegate-spike set
    echo "  get (default)"; t prosegate-spike get
    echo "  set (secret-service)"; SPIKE_STORE=secret-service t prosegate-spike set
    echo "  delete (default)"; t prosegate-spike delete'
else echo "  (dbus not installed in this image)"; fi
