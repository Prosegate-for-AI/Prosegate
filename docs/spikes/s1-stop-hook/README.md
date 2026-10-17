# S1 — Stop hook surface: how to run

Needs a logged-in `claude` CLI (`claude auth login`). Uses an isolated `--settings` file; your `~/.claude/settings.json` is not touched.

## Headless (2 runs, about 2 minutes, a few cents on Haiku)

```bash
node docs/spikes/s1-stop-hook/run.mjs
```

Prints a JSON report and the path to `s1-report.json`. Send that file back. It contains the spike prompt and the model's throwaway replies, nothing else.

## Interactive (about 2 minutes, needs your eyes)

This answers the one question headless can't: does Claude Code's terminal show a Stop hook's `systemMessage` to the user?

1. Make an empty folder and `cd` into it.
2. Write the settings file there (replace `<repo>` with the repo path, forward slashes):

   ```json
   {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node \"<repo>/docs/spikes/s1-stop-hook/hook.mjs\" Stop","timeout":10}]}]}}
   ```

3. Run `claude --settings settings.json --model haiku` and type: `Write one sentence using the word robust.`
4. Note what you see: (a) a line containing `SYSMSG-SPIKE pass 1 of 2`? (b) the `[Prosegate-spike] pass 1` reason text? (c) does the revised reply start with `NOTICE-VIA-MODEL 1`? (d) the same for pass 2? (e) after pass 2, does the session stop on its own?
5. Delete the folder. The hook writes `events.jsonl`, `stopcount` and `transcript-at-stop-*.jsonl` beside `hook.mjs`; delete those too, they are throwaway.
