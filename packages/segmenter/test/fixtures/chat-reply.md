Sure, here's what I found. The failing test is `parses nested lists`, and it fails because the fixture has a trailing tab.

Two options:

1. Strip trailing whitespace in the parser (smallest change).
2. Fix the fixture and leave the parser alone.

I'd go with option 2 — the parser is behaving correctly. Want me to make the change?
