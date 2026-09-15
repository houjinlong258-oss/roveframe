-- RoveFrame schema sync patch (generated from src/storage/database/shared/schema.ts)
-- Idempotent: safe to run multiple times.
begin;

create table if not exists public.audit_events (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null default '',
  business_id varchar(36) not null default '',
  user_id varchar(36) default '',
  agent_id varchar(64) default '',
  tool_name varchar(128) default '',
  action varchar(64) not null default '',
  arguments_hash varchar(64) default '',
  approval_id varchar(36) default '',
  execution_id varchar(36) default '',
  result jsonb default '{}'::jsonb,
  actor_role varchar(20) default '',
  status varchar(24) not null default '',
  created_at timestamp with time zone not null default now()
);

create table if not exists public.health_check (
  id serial not null,
  updated_at timestamp with time zone default now()
);

create table if not exists public.integration_events (
  id varchar(36) primary key default gen_random_uuid(),
  tenant_id varchar(36) not null default '',
  business_id varchar(36) not null default '',
  provider varchar(30) not null default '',
  external_event_id varchar(255) not null default '',
  event_type varchar(100) not null default '',
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamp with time zone default now(),
  created_at timestamp with time zone not null default now()
);

-- 1) add missing columns
alter table public.agent_approvals add column if not exists requester varchar(128);
alter table public.agent_approvals add column if not exists agent varchar(64);
alter table public.agent_approvals add column if not exists tool_name varchar(128);
alter table public.agent_approvals add column if not exists arguments jsonb;
alter table public.agent_approvals add column if not exists arguments_hash varchar(64);
alter table public.agent_approvals add column if not exists risk_level varchar(16);
alter table public.agent_approvals add column if not exists required_role varchar(20);
alter table public.agent_approvals add column if not exists invocation_id varchar(128);
alter table public.agent_approvals add column if not exists execution_id varchar(36);
alter table public.agent_approvals add column if not exists approved_by varchar(36);
alter table public.agent_approvals add column if not exists consumed_at timestamp with time zone;
alter table public.agent_approvals add column if not exists executed_at timestamp with time zone;
alter table public.agent_approvals add column if not exists failed_at timestamp with time zone;
alter table public.agent_approvals add column if not exists execution_result jsonb;
alter table public.agent_approvals add column if not exists last_error text;
alter table public.chat_messages add column if not exists user_id varchar(36);
alter table public.chat_sessions add column if not exists user_id varchar(36);
alter table public.chat_sessions add column if not exists summary text;
alter table public.chat_sessions add column if not exists summarized_message_count integer;
alter table public.customers add column if not exists source varchar(20);
alter table public.customers add column if not exists external_id varchar(128);
alter table public.doc_chunks add column if not exists business_id varchar(36);
alter table public.email_accounts add column if not exists business_id varchar(36);
alter table public.email_send_tasks add column if not exists business_id varchar(36);
alter table public.email_send_tasks add column if not exists campaign_id varchar(36);
alter table public.email_send_tasks add column if not exists approval_id varchar(36);
alter table public.email_send_tasks add column if not exists execution_id varchar(36);
alter table public.email_send_tasks add column if not exists failed_at timestamp with time zone;
alter table public.email_send_tasks add column if not exists claimed_at timestamp with time zone;
alter table public.email_send_tasks add column if not exists attempts integer;
alter table public.email_send_tasks add column if not exists max_attempts integer;
alter table public.email_send_tasks add column if not exists provider_message_id varchar(255);
alter table public.email_send_tasks add column if not exists last_error text;
alter table public.emails add column if not exists business_id varchar(36);
alter table public.integration_configs add column if not exists business_id varchar(36);
alter table public.knowledge_docs add column if not exists business_id varchar(36);
alter table public.marketing_contents add column if not exists business_id varchar(36);
alter table public.marketing_contents add column if not exists approval_id varchar(36);
alter table public.marketing_contents add column if not exists sent_at timestamp with time zone;
alter table public.payment_events add column if not exists business_id varchar(36);
alter table public.payment_events add column if not exists processed_at timestamp with time zone;
alter table public.payment_events add column if not exists last_error text;
alter table public.payments add column if not exists provider_payment_id varchar(255);
alter table public.payments add column if not exists refunded_amount_minor bigint;
alter table public.payments add column if not exists reconciled_at timestamp with time zone;
alter table public.products add column if not exists business_id varchar(36);
alter table public.products add column if not exists source varchar(20);
alter table public.products add column if not exists external_id varchar(128);
alter table public.reservations add column if not exists business_id varchar(36);
alter table public.reservations add column if not exists due_amount numeric(10, 2);
alter table public.settings add column if not exists business_id varchar(36);
alter table public.staff add column if not exists business_id varchar(36);

-- 2) backfill
update public.agent_approvals set requester='' where requester is null;
update public.agent_approvals set agent='' where agent is null;
update public.agent_approvals set tool_name='' where tool_name is null;
update public.agent_approvals set arguments='{}'::jsonb where arguments is null;
update public.agent_approvals set arguments_hash='' where arguments_hash is null;
update public.agent_approvals set risk_level='' where risk_level is null;
update public.agent_approvals set required_role='' where required_role is null;
update public.agent_approvals set invocation_id='' where invocation_id is null;
update public.agent_approvals set execution_id='' where execution_id is null;
update public.agent_approvals set approved_by='' where approved_by is null;
update public.agent_approvals set consumed_at=now() where consumed_at is null;
update public.agent_approvals set executed_at=now() where executed_at is null;
update public.agent_approvals set failed_at=now() where failed_at is null;
update public.agent_approvals set execution_result='{}'::jsonb where execution_result is null;
update public.agent_approvals set last_error='' where last_error is null;
update public.chat_messages set user_id='' where user_id is null;
update public.chat_sessions set user_id='' where user_id is null;
update public.chat_sessions set summary='' where summary is null;
update public.chat_sessions set summarized_message_count=0 where summarized_message_count is null;
update public.customers set source='' where source is null;
update public.customers set external_id='' where external_id is null;
update public.doc_chunks set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.email_accounts set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.email_send_tasks set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.email_send_tasks set campaign_id='' where campaign_id is null;
update public.email_send_tasks set approval_id='' where approval_id is null;
update public.email_send_tasks set execution_id='' where execution_id is null;
update public.email_send_tasks set failed_at=now() where failed_at is null;
update public.email_send_tasks set claimed_at=now() where claimed_at is null;
update public.email_send_tasks set attempts=0 where attempts is null;
update public.email_send_tasks set max_attempts=0 where max_attempts is null;
update public.email_send_tasks set provider_message_id='' where provider_message_id is null;
update public.email_send_tasks set last_error='' where last_error is null;
update public.emails set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.integration_configs set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.knowledge_docs set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.marketing_contents set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.marketing_contents set approval_id='' where approval_id is null;
update public.marketing_contents set sent_at=now() where sent_at is null;
update public.payment_events set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.payment_events set processed_at=now() where processed_at is null;
update public.payment_events set last_error='' where last_error is null;
update public.payments set provider_payment_id='' where provider_payment_id is null;
update public.payments set refunded_amount_minor=0 where refunded_amount_minor is null;
update public.payments set reconciled_at=now() where reconciled_at is null;
update public.products set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.products set source='' where source is null;
update public.products set external_id='' where external_id is null;
update public.reservations set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.reservations set due_amount=0 where due_amount is null;
update public.settings set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;
update public.staff set business_id='00000000-0000-0000-0000-000000000001' where business_id is null;

-- 3) enforce not null
alter table public.agent_approvals alter column agent set not null;
alter table public.agent_approvals alter column arguments set not null;
alter table public.agent_approvals alter column risk_level set not null;
alter table public.agent_approvals alter column required_role set not null;
alter table public.agent_approvals alter column invocation_id set not null;
alter table public.chat_messages alter column user_id set not null;
alter table public.chat_sessions alter column user_id set not null;
alter table public.chat_sessions alter column summary set not null;
alter table public.chat_sessions alter column summarized_message_count set not null;
alter table public.customers alter column source set not null;
alter table public.doc_chunks alter column business_id set not null;
alter table public.email_accounts alter column business_id set not null;
alter table public.email_send_tasks alter column business_id set not null;
alter table public.email_send_tasks alter column attempts set not null;
alter table public.email_send_tasks alter column max_attempts set not null;
alter table public.emails alter column business_id set not null;
alter table public.integration_configs alter column business_id set not null;
alter table public.knowledge_docs alter column business_id set not null;
alter table public.marketing_contents alter column business_id set not null;
alter table public.payment_events alter column business_id set not null;
alter table public.payments alter column refunded_amount_minor set not null;
alter table public.products alter column business_id set not null;
alter table public.products alter column source set not null;
alter table public.reservations alter column business_id set not null;
alter table public.settings alter column business_id set not null;
alter table public.staff alter column business_id set not null;

commit;
