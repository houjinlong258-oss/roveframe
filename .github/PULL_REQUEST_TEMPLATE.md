## What this changes

<!-- One or two sentences. What is different after this PR? -->

## Why

<!-- The problem this solves. Link the issue if there is one. -->

## How it was verified

<!--
Paste the commands you ran and what they printed. This project's standard is that a change is
not "done" until a command proves it.

    pnpm validate
    python scripts/run-python-tests.py

-->

## Negative control

<!--
For a new or changed guard, what did you break to prove the guard can fail? If you could not
produce a failure, say so plainly — "this check does not prove anything yet" is a useful review
comment, not a failure.

Skip this section only if the change genuinely adds no guard.
-->

## What you previously got wrong

<!--
Optional, and welcome. If this PR corrects an earlier conclusion, keep the original statement
visible rather than quietly rewriting history.
-->

## Risk and blast radius

- [ ] Touches authentication, tenancy, or the permission model
- [ ] Touches money paths (payments, refunds, reconciliation)
- [ ] Touches the agent tool loop, approvals, or audit
- [ ] Changes the database contract (migrations)
- [ ] Requires a new environment variable or a deployment change

<!-- If any box is ticked, say what you checked beyond the test suite. -->

## Checklist

- [ ] `pnpm validate` exits 0
- [ ] No credentials, tokens, `.env` files or build artifacts are included
- [ ] Docs updated if behaviour or setup changed
