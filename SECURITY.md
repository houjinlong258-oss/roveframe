# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not through a public issue:

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  on this repository, or
- Contact the maintainer directly through the address on their GitHub profile.

Please include: what you did, what happened, what you expected, and the smallest reproduction you
can manage. If the issue involves credentials, do not paste the credential value — describe where
it lives instead.

## What this project already assumes

The design decisions below are deliberate. Reports that misunderstand them are still welcome, but
knowing them will save you time.

| Assumption | Why |
|---|---|
| The Supabase **service-role key is server-side only**. | It bypasses row-level security. It is never shipped to a browser, and the only client-visible key is the anon key. |
| Row-level security is the **second** line of defence, not the only one. | Application-layer scoping (verified `tenant_id` + `business_id` injected by the network boundary) runs first; RLS backstops it. A report that "RLS would allow X if the app let it" is a real finding — and the app layer is expected to block it too. |
| Rate limiting is **in-process** and single-replica by design. | Multi-replica deployments are required to declare a shared backend; the startup contract check fails loudly if a deployment claims one and does not have it. |
| Audit writes are **fail-closed**. | If an audit record cannot be written, the operation fails rather than executing unrecorded. |
| The agent runtime holds **no privileged database credentials**. | Model-driven actions go through the tool registry and the approval system, not direct table writes. |

## Known limitations

Honest disclosure beats a clean-looking README:

- Automated recurring billing is not implemented; merchant subscriptions are provisioned manually
  by an operator with offline payment records.
- Several scripts under `scripts/` are operational and forensic tools that require credentials to
  run. They are safe to read; running them against a database you do not own is on you.
- `docs/` contains internal engineering audit reports, including records of past defects and
  remediation. They are published on purpose — the reasoning is part of the portfolio — and they
  describe issues that have been fixed. If you find a *currently* exploitable issue described
  there as fixed but still live, that is a security report: please send it privately.

## Supported versions

This is a pre-launch project that tracks `main`. Fixes land on `main`; there are no maintained
release branches yet.
