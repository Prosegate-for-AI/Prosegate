// SEA variant of the keyring loader: the .node binary is embedded as a SEA asset,
// extracted once to ~/.prosegate/native/<hash>.node, then loaded with process.dlopen.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sea = require('node:sea');

const buf: ArrayBuffer = sea.getAsset('keyring.node');
const hash = createHash('sha256').update(new Uint8Array(buf)).digest('hex').slice(0, 16);
const dir = join(process.env.PROSEGATE_SPIKE_HOME ?? join(homedir(), '.prosegate-spike'), 'native');
const file = join(dir, `keyring-${hash}.node`);
if (!existsSync(file)) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, new Uint8Array(buf), { mode: 0o700 });
  renameSync(tmp, file);
}
const m = { exports: {} as any };
process.dlopen(m, file);
export const Entry = m.exports.Entry;
export const AsyncEntry = m.exports.AsyncEntry;
export const findCredentials = m.exports.findCredentials;
