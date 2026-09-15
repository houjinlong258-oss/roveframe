-- Step 3：chat_sessions runtime 元数据列（审计用）
--
-- 目的：让「这条回答是 RoveAgent Runtime 出的，还是 TS 降级出的」
-- 在数据层可查证。本次改造之前，这个问题无从回答。
--
-- 幂等：全部使用 ADD COLUMN IF NOT EXISTS，可重复执行。
-- 应用方式（本机无 DB 凭据，需由具备 .env 的环境执行）：
--   psql "<Session pooler URL>" -f scripts/migrate-runtime-metadata.sql
-- 或 Supabase SQL Editor 直接粘贴执行。
--
-- 列可空且无默认值：历史会话保持 NULL，语义为「迁移前无记录」——
-- 不伪装成 roveagent。

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS runtime_mode varchar(20);

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS runtime_agent varchar(40);

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS runtime_request_class varchar(20);

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS runtime_tool_intent varchar(20);

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS runtime_at timestamptz;

-- 审计查询通常按「降级发生的会话」筛，加一个部分索引避免全表扫。
-- 只索引非 NULL 行（历史数据 NULL 不占索引）。
CREATE INDEX IF NOT EXISTS chat_sessions_runtime_mode_idx
  ON chat_sessions (runtime_mode)
  WHERE runtime_mode IS NOT NULL;

COMMENT ON COLUMN chat_sessions.runtime_mode IS
  'Step 3: roveagent | fallback | unavailable — 最近一轮实际执行该会话的 Runtime';
COMMENT ON COLUMN chat_sessions.runtime_agent IS
  'Step 3: 实际执行的 agent key（如 developer / ceo）';
COMMENT ON COLUMN chat_sessions.runtime_request_class IS
  'Step 3: chat | tool_execution — 服务端请求分类';
COMMENT ON COLUMN chat_sessions.runtime_tool_intent IS
  'Step 3: file | terminal | process | deploy | media | plugin（仅 tool_execution）';
COMMENT ON COLUMN chat_sessions.runtime_at IS
  'Step 3: 上述元数据的写入时刻';
