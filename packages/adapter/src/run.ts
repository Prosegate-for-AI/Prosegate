import { VERSION } from "./version.js";

export interface Writer {
  write(chunk: string): unknown;
}

const USAGE = `usage: prosegate <command>

commands:
  --version    print the version
  --help       show this help
  init         set up a harness (not available in this build yet)
`;

/** CLI body, kept free of process globals so it is unit-testable. Returns the exit code. */
export function run(argv: readonly string[], out: Writer, err: Writer): number {
  const [first] = argv;
  switch (first) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      out.write(USAGE);
      return 0;
    case "--version":
    case "-v":
      out.write(`${VERSION}\n`);
      return 0;
    case "init":
      err.write("prosegate init is not available in this build yet.\n");
      return 1;
    default:
      err.write(`prosegate: unknown command "${first}". Run prosegate --help.\n`);
      return 1;
  }
}
