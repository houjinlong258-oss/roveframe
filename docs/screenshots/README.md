# Screenshots

This directory is where product screenshots live **when they are real**.

There are none yet. The product surface exists and runs, but no screenshots have been captured
for publication, and this project does not ship mockups or generated images that pretend to be
the running application. The architecture overview and logo under `docs/assets/` are diagrams and
brand assets — they are labelled as such in the README and are not presented as screenshots.

## How to add a screenshot properly

1. Run the application locally (`pnpm dev`), or the production build:

   ```bash
   pnpm build && npx next start -p 5067
   ```

2. Capture the real surface. Use a clean dataset — do not capture a screen containing real
   customer names, phone numbers, addresses or mailbox contents. The dashboard reads live tenant
   data, so if you are pointing at a real project, use an account with synthetic data only.

3. Suggested first set, covering what a reader most needs to see:

   | File | Surface |
   |---|---|
   | `dashboard.png` | Executive dashboard with real KPI cards |
   | `agent-approval.png` | An agent proposal with its frozen argument payload awaiting approval |
   | `agent-chat.png` | Streaming agent conversation showing tool calls |
   | `audit-trail.png` | Audit records for one executed action |
   | `store-menu.png` | The public customer ordering surface (PWA) |

4. Keep each file under ~500 KB, width around 1600 px, PNG. Redact anything tenant-identifying
   and say in the PR what you redacted.

5. Reference them from `README.md` in the relevant section, with a one-line caption describing
   what a reviewer should notice (not just "screenshot of the dashboard").

## Why this file exists at all

A portfolio repository that shows a grid of polished screenshots which do not correspond to any
runnable state is worse than one that shows none: the first question a reviewer asks is "does
this actually run", and a fake screenshot answers it incorrectly. Blank and honest beats
decorated and unverifiable.
