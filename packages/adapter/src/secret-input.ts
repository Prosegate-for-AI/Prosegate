/** Hidden terminal input: no echo, readline history, argv or environment copy. */
export function readSecret(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return Promise.reject(new Error("terminal required"));
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    let value = "";
    const finish = (ok: boolean) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write("\n");
      if (ok) resolve(value); else reject(new Error("key input cancelled"));
    };
    const onEnd = () => finish(false);
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") { finish(false); return; }
        if (char === "\r" || char === "\n") { finish(true); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= "!" && char <= "~") value += char;
        else { finish(false); return; }
        if (value.length > 1000) { finish(false); return; }
      }
    };
    process.stderr.write("Reviewer API key (hidden): ");
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
    input.resume();
  });
}
