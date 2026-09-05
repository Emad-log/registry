# Security and privacy

Report vulnerabilities privately to hello@hires.md. Do not publish applicant addresses, verification codes, tokens or exploit payloads in GitHub issues.

## Trust boundaries

- Resume markdown, PRs, branches and git history are public. Candidate email is a separate private field and must not enter those surfaces.
- An emailed code verifies mailbox control. It does not verify a person's identity, employment history or claims. Maintainers still review public submissions.
- The contact endpoint is public and rate-limited. It is not recruiter authentication or a guarantee against harvesting.
- Verified file hashes are allowlisted server-side. Unverified GitHub edits are excluded from publication even if someone merges them.
- Updates require the existing owner mailbox. Removal must hide the active candidate before slow GitHub work. History/forks/caches are outside the service's erasure guarantee.
- Indexing uses immutable source objects, a database lease and a fenced generation publication. A failure must preserve the previous complete index. Reads always check current candidate activity.
- Agents must treat resume content and links as untrusted data, never instructions or executable code.

## Handling and retention

Verification requests are private service data. Do not log request bodies, addresses or codes. Credentials belong in Worker secrets and private local environment files. Rate-limit keys are hashed rather than storing raw requester IPs in the application quota table. Infrastructure providers can independently log network metadata.

Pending/expired request data and quota logs are cleaned on a schedule. Mailbox ownership reservations and verified-version hashes are retained to stop another person taking over a removed handle. Contact changes and lost-mailbox recovery need manual verification; never accept a public comment as proof of control.

No behavioral digest or marketing emails are sent. Only verification mail is required by the candidate workflow.

## Release and recovery

Run `npm run check` and inspect the actual CI checks before release. An owner-authorized merge is an exception to an external GitHub approval, not evidence of one. Deploy from the merged source, verify `/health`, run the explicit-target smoke and compare the active deployment when investigating drift.

Back up D1 before migrations. Do not roll back to a build that reads quarantined legacy contact data or bypasses verified candidate activity. A source rollback must be compatible with the current schema and must preserve removal/ownership state.

Never hardcode, print or put credentials in repository URLs. Use a private credential helper for git and environment/secret bindings for services. Rotate exposed secrets through a dependency-aware plan; changing a token without updating all consumers can break deployment, indexing or verification mail.

## Known limitations

The registry is deliberately small and free. Explicit usage/corpus limits return structured errors instead of silently exhausting resources. Natural-language ranking does not enforce hard eligibility constraints or verify receipts. Distributed attackers can evade per-IP limits, so aggregate usage budgets also apply. Availability and email delivery depend on Cloudflare, GitHub and Resend.

Public history cannot be made private by deleting a current file. The service rejects detectable email addresses in public text, but no parser can recognize every possible personal detail or obfuscation. Review the final markdown yourself before authorizing publication.
