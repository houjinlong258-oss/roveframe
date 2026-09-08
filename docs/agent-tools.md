# Agent Tool API

## `POST /api/agent/tools/execute`

Internal owner/manager/staff Agent boundary for read-only business tools. The
request must carry either the `rf_session` HttpOnly cookie or a verified
Bearer token. `tenant_id`, `business_id`, `user_id`, and role are resolved on
the server from the authenticated user; they cannot be supplied by the caller.

### Request

```json
{
  "tool": "analytics.get_sales_summary",
  "input": { "period": "week" },
  "sessionId": "optional-session-id",
  "turnId": "optional-turn-id"
}
```

`sessionId` and `turnId` are optional correlation values. If omitted, the API
generates them for the execution. Tool input is validated by the tool's own
Zod schema.

### Available read-only tools

| Tool | Required permission | Input |
|---|---|---|
| `analytics.get_sales_summary` | `orders:read` | `{ "period": "today" | "week" }` |
| `reviews.get_negative_trend` | `reviews:read` | `{}` |
| `customers.get_risk_summary` | `customers:read` | `{}` |
| `inventory.get_low_stock` | `inventory:read` | `{}` |

### Response

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Failure responses use the same structured error body:

```json
{
  "ok": false,
  "error": {
    "code": "forbidden | invalid_input | tool_timeout | tool_error",
    "message": "..."
  }
}
```

Every execution writes a bounded, sensitive-input-redacted lifecycle record
to `agent_actions`. External side effects and write tools are not exposed by
this endpoint yet.

## `GET /api/agent/actions`

Returns the current business's Agent tool audit feed. This endpoint is
owner-only through `agent_actions:read`; optional query parameters are
`limit` (1-100), `tool`, and `status`.

## Chat integration

`POST /api/agent/chat` runs through the Agent Gateway. External Anthropic and
OpenAI-compatible models can select tools through their native tool APIs. The
platform text-only model uses a bounded deterministic fallback planner for
the same read-only tools. Every execution still passes through the Registry;
the model never receives database credentials or tenant identifiers.

## Autonomous Agent infrastructure

The scheduler now creates two durable definitions per business:

- `daily_briefing` (`0 8 * * *`, represented by a 24-hour durable interval)
- `event_detection` (15-minute durable interval)

Each scheduled slot produces one `agent_task_runs` row keyed by
`scheduled:<task_id>:<next_run_at>`. The PostgreSQL
`claim_agent_task_runs(worker_id, limit)` function uses a row lock and
`FOR UPDATE SKIP LOCKED`, so multiple application instances cannot execute the
same run concurrently. Failed runs use bounded exponential backoff and stop
after `max_attempts`; expired leases are returned to the queue.

Event detection writes tenant/business-scoped rows to `agent_events` and
creates notification intents in `notification_outbox`. It does not call Web
Push, email, or chat providers. The separate dispatcher claims outbox rows via
`claim_notification_outbox` and currently supports the `web_push` transport.
Set `ROVEFRAME_ENABLE_NOTIFICATION_DISPATCH=true` only after the deployment has
configured and verified `WEB_PUSH_VAPID_SUBJECT`,
`WEB_PUSH_VAPID_PUBLIC_KEY`, and `WEB_PUSH_VAPID_PRIVATE_KEY`. The dispatcher
uses the standard VAPID/encrypted Web Push protocol supported by Chrome Android
and Safari iOS; missing credentials fail closed and leave the outbox retryable.

## `GET /api/notifications`

Owner and manager notification center endpoint. Events are scoped to the
authenticated business; optional query parameters are `limit` and `status`
(`open`, `acknowledged`, or `resolved`).

`PATCH /api/notifications` accepts `{ "id": "...", "status": "acknowledged" }`
or `resolved` and cannot update an event outside the current tenant/business.
