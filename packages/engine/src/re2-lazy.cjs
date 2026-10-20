/* global module, require */
// A CommonJS factory keeps the synchronous compiler lazy in Node and in the
// self-contained bundle. The audited core path needs no RE2 instance.
module.exports = function compile(source) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- synchronous lazy bundle initialization
  const { RE2JS } = require("re2js");
  return RE2JS.compile(source, 0);
};
