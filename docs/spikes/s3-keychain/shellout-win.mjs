// Option (c) assessment on Windows: no native addon, shell out to Windows PowerShell 5.1 + WinRT PasswordVault.
// Secret goes over stdin (never argv). Dummy only. Resource name `prosegate-spike-ps`.
import { spawnSync } from 'node:child_process';
const DUMMY = 'prosegate-spike-dummy-not-a-secret';
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const pre = "$null=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;";
const scripts = {
  set: pre + "$p=[Console]::In.ReadToEnd();$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('prosegate-spike-ps','device-key',$p)))",
  get: pre + "$c=$v.Retrieve('prosegate-spike-ps','device-key');$c.RetrievePassword();[Console]::Out.Write($c.Password)",
  del: pre + "$v.Remove($v.Retrieve('prosegate-spike-ps','device-key'))",
  getmissing: pre + "try{$v.Retrieve('prosegate-spike-ps','device-key')|Out-Null;'present'}catch{'absent'}",
};
const ps = (name, input) => { const t = performance.now(); const r = spawnSync('powershell.exe', [...PS, scripts[name]], { input, encoding: 'utf8' }); return { ms: performance.now() - t, out: r.stdout, err: r.stderr, status: r.status }; };
const s = ps('set', DUMMY); console.log('set', s.status, s.ms.toFixed(0) + 'ms', s.err.trim().slice(0, 200));
const ws = [];
for (let i = 0; i < 10; i++) { const g = ps('get'); if (g.out !== DUMMY) { console.log('get mismatch', g.status, g.err.slice(0, 300)); break; } ws.push(g.ms); }
ws.sort((a, b) => a - b);
console.log(`get via powershell.exe: p50=${ws[Math.ceil(ws.length * 0.5) - 1]?.toFixed(0)}ms p95=${ws[Math.ceil(ws.length * 0.95) - 1]?.toFixed(0)}ms (n=${ws.length})`);
const d = ps('del'); console.log('delete', d.status, d.ms.toFixed(0) + 'ms', d.err.trim().slice(0, 200));
console.log('after delete:', ps('getmissing').out.trim());
