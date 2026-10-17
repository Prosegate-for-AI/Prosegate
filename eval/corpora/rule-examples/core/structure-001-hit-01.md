## What happened

The nightly export failed on Tuesday at 02:14, and the job left a partial archive in the shared bucket. Nothing downstream picked it up, but the finance team did not get its morning report until I reran the job by hand at 09:30.

## Cause

The export writes a temporary copy of each table before it compresses the data. The orders table grew past 40 GB last week, so the 50 GB scratch volume filled up halfway through the run. The error in the log said only "write failed", which hid the real reason for two days. The new schema was not involved.

## Fix

I changed the job to stream each table straight into the compressor, so no temporary copy exists. Peak disk use now stays under 2 GB. The change is 40 lines and touches nothing else in the pipeline. No new dependency was needed.

## Verification

I ran the new job against a copy of production data on Wednesday. It finished in 51 minutes, and the row counts matched for all 38 tables.

## Rollout

The change ships with tonight's release. If the run fails again, flip the `export_mode` flag back to `legacy` and the old job returns. The flag is read at the start of each run, so no restart is needed.

## Open risks

The compressor runs on a single thread, so a table above 200 GB would push the export past its four hour window. We are nowhere near that today. I would still add a size alert at 100 GB, and I can do that tomorrow if you agree.
