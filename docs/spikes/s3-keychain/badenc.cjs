// Q5: does a BadEncoding error on getPassword leak the stored bytes? Dummy only.
const { Entry } = require('@napi-rs/keyring');
const DUMMY = 'prosegate-spike-dummy-not-a-secret';
const e = new Entry('prosegate-spike', 'badenc');
// Odd byte length + lone 0xFF bytes so it is neither valid UTF-16 nor UTF-8.
const bytes = Buffer.concat([Buffer.from(DUMMY, 'utf8'), Buffer.from([0xff, 0xfe, 0xff])]);
e.setSecret(bytes);
try {
  const v = e.getPassword();
  console.log(JSON.stringify({ getPassword: 'returned', length: v && v.length, includesDummy: String(v).includes(DUMMY) }));
} catch (err) {
  const msg = String(err.message);
  const asNums = bytes.slice(0, 8).join(', ');
  console.log(JSON.stringify({ getPassword: 'threw', code: err.code, msgLen: msg.length, includesDummyText: msg.includes(DUMMY), includesByteList: msg.includes(asNums), msgHead: msg.slice(0, 60).replace(/\d+/g, '#') }));
}
console.log(JSON.stringify({ deleted: e.deletePassword(), after: e.getPassword() }));
