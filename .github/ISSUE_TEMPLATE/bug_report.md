---
name: Bug report
about: Something behaves incorrectly
title: "[bug] "
labels: bug
---

## What happened

<!-- What did you observe? Paste the exact error or output. -->

## What you expected

<!-- What should have happened instead? -->

## How to reproduce

```bash
# smallest sequence of commands that shows the problem
```

## Environment

| | |
|---|---|
| Commit / branch | |
| Node / pnpm / Python version | |
| Deployment | local `pnpm dev` / production build / Docker Compose |

## Evidence

<!--
Output of the relevant gate, if you ran one:

    pnpm validate
    python scripts/run-python-tests.py

If a check reported success but you believe it should have failed, say so explicitly — a guard
that cannot fail is treated as a defect in this project, not as coverage.
-->

## Anything else

<!-- Logs, screenshots, related issues. Do not paste credentials. -->
