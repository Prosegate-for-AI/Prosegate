// Simulates a hung D-Bus daemon: accepts connections on a unix socket and never replies.
// Usage: node stall-dbus.cjs /tmp/stall.sock &   then DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/stall.sock
const net = require('node:net');
const fs = require('node:fs');
const p = process.argv[2] || '/tmp/stall.sock';
try { fs.unlinkSync(p); } catch {}
net.createServer((s) => { s.on('data', () => {}); }).listen(p, () => console.error(`stall-dbus listening on ${p}`));
