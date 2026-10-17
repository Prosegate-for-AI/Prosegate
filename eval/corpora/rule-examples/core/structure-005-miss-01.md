To rotate the signing key, first pause the deploy pipeline so that no release picks up a half-changed config.

Then generate the new key with `keygen --rotate` and store it in the secrets manager under a new version name. Update the version variable in staging and run the smoke tests against it. If they pass, promote the same change to production during a low traffic window. Once production is serving the new key, revoke the old key and resume the pipeline. Set a reminder for the next rotation, which falls due 90 days from today.

**Do not delete the old key for 24 hours, or tokens that are already issued will stop working.**

Ask someone on the platform team to confirm that the new key id appears in the public key endpoint, then close the ticket.
