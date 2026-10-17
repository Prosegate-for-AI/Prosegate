// Confirms no spike entries remain. Queries ONLY the spike's own service names; prints counts and account names, never values.
const { findCredentials, Entry } = require('@napi-rs/keyring');
for (const svc of ['prosegate-spike']) {
  const found = findCredentials(svc);
  console.log(JSON.stringify({ service: svc, remaining: found.length, accounts: found.map((c) => c.account) }));
}
for (const acct of ['device-key', 'badenc']) console.log(JSON.stringify({ service: 'prosegate-spike', account: acct, present: new Entry('prosegate-spike', acct).getPassword() !== null }));
