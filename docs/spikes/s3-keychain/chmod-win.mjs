// Q4: what does fs.chmod(path, 0o600) / writeFile({mode:0o600}) do on Windows? Dummy content only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = path.join(process.argv[2] ?? '.', 'chmod-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const icacls = (p) => execFileSync('icacls', [p], { encoding: 'utf8' }).trim().split(/\r?\n/).slice(0, -1).map(l => l.replace(p, '<file>').replace(/S-1-5-21-[\d-]+/g, '<SID>').replace(new RegExp(`^.*?${process.env.COMPUTERNAME ?? '#'}\\\\`, 'i'), (m) => m.replace(process.env.COMPUTERNAME ?? '#', '<HOST>')).replace(process.env.COMPUTERNAME ?? '#', '<HOST>').trim()).filter(Boolean);
const attrib = (p) => execFileSync('cmd', ['/c', 'attrib', p], { encoding: 'utf8' }).trim().slice(0, 12).trim();
const report = (label, p) => console.log(JSON.stringify({ label, mode: (fs.statSync(p).mode & 0o777).toString(8), attrib: attrib(p) || '(none)', acl: icacls(p) }));

const a = path.join(dir, 'a-writeFile-mode600');
fs.writeFileSync(a, 'prosegate-spike-dummy-not-a-secret', { mode: 0o600 });
report('writeFileSync(mode 0o600)', a);

const b = path.join(dir, 'b-chmod600');
fs.writeFileSync(b, 'prosegate-spike-dummy-not-a-secret');
report('default writeFileSync', b);
fs.chmodSync(b, 0o600);
report('after chmodSync(0o600)', b);
fs.chmodSync(b, 0o400);
report('after chmodSync(0o400)', b);
fs.chmodSync(b, 0o600);

// Proposed fallback hardening on Windows: strip inherited ACEs and grant only the current user SID (+ SYSTEM).
const c = path.join(dir, 'c-icacls');
fs.writeFileSync(c, 'prosegate-spike-dummy-not-a-secret');
const sid = execFileSync(path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().split(',').pop().replace(/"/g, '');
const t = performance.now();
execFileSync('icacls', [c, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'], { encoding: 'utf8' });
console.log(`icacls hardening took ${(performance.now() - t).toFixed(0)}ms`);
report('after icacls /inheritance:r /grant:r <user SID>:F SYSTEM:F', c);
console.log('read back ok:', fs.readFileSync(c, 'utf8') === 'prosegate-spike-dummy-not-a-secret');
fs.rmSync(dir, { recursive: true, force: true });
