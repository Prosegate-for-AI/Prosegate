/* global module, require */
// Keep parser initialization off the byte-identical bundled JSON path.
// Bundlers inline this literal require; no Node API is added to the Worker.
module.exports = function loadYaml() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- synchronous lazy bundle initialization
  return require("yaml");
};
