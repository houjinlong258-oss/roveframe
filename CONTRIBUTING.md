# Contributing to RoveFrame

Thanks for taking a look. This project is a working system with strict verification rules, so
the most useful contributions are usually small, well-evidenced ones.

## Before you start

**Only `pnpm` is supported for JavaScript.** `npm` and `yarn` are rejected by a `preinstall`
guard. Python work uses an editable install:

```bash
pnpm install --frozen-lockfile
pip install -e "./roveagent[web]"
```

## The one rule that matters

> **A claim is not evidence until a command proves it.**

This repository has a documented history of checks that could not fail — a probe that returned
"healthy" for a table that did not exist, a test that asserted SQL text while the database was
wide open. Every one of those was worse than no check at all, because it created false
confidence.

So, when you add or change a guard:

1. **Prove it can fail.** Break the thing it guards (or revert the fix), run it, and confirm it
   goes red. If you cannot produce a failure, the check does not prove anything — say so.
2. **Report numbers you measured.** If something cannot be measured in your environment, write
   `UNVERIFIED` and explain what is missing. Do not estimate.
3. **Prefer failing closed.** If a dependency is unavailable, the operation should fail loudly
   rather than degrade into a silent success.

## Definition of done

```bash
pnpm validate            # migrations contract, types, lint, tests, production scan
python scripts/run-python-tests.py   # execution-plane suite
```

`pnpm validate` must exit 0. It is the same gate CI runs, plus the container builds.

Changes that touch the database contract should also keep these green:

```bash
pnpm validate:migrations   # schema definition vs migration files
pnpm validate:alerts       # alert rules vs exported metrics
```

## Commit messages

Explain **what changed, why, how it was verified, and what you previously got wrong** if you are
correcting an earlier conclusion. A commit that says "fix bug" costs the next reader more than
it saves you.

## Pull requests

- Keep the diff scoped to one concern.
- Fill in the PR template, especially the verification section.
- If your change touches authentication, tenancy, money, or the agent tool loop, expect a
  request for the negative control.

## Reporting security issues

Please do not open a public issue for a security problem — see [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the MIT licence (see [LICENSE](LICENSE)). Third-party code must
keep its attribution in the designated `LICENSE` / `NOTICE` / `THIRD_PARTY_NOTICES.md` files.
