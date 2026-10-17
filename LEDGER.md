# LEDGER

Append-only. One line per work-item exit, phase exit, and escalation.

Format: `date · kind · item · cycles · result / proving command · accepted-with-reason · debt`

- 2026-10-17 · start · Orchestration begun; specs 01–11 read; state files created.
- 2026-10-17 · escalation · HQ-1 (S2 needs OpenAI admin key), HQ-2 (auth provider), HQ-3 (licences; 07 'open source' vs ADR-7), HQ-4 (name), HQ-5 (claude CLI login expired; S1 live run)
- 2026-10-17 · spec · ADR-8 drafted from plan §1 ('no hard spend cap'), then replaced before first commit after S2 found and I verified the provider's project hard spend limit (openai-openapi spec); ADR-8 now = hard limit + rate limits + allowlist + polling/revoke. ADR-9 = Stop mapping (plan §2 items 1, 3, 4). Edited 05, 07, 09, 11 §1, Overview.
