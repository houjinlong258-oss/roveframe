import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  bigint,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  vector,
} from "drizzle-orm/pg-core";

// 系统表，禁止删除
export const healthCheck = pgTable("health_check", {
  id: serial().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
});

// ---------- 平台 / 多租户 ----------
export const tenants = pgTable("tenants", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 128 }).notNull(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  plan: varchar("plan", { length: 20 }).notNull().default("free"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const businesses = pgTable("businesses", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
  name: varchar("name", { length: 128 }).notNull(),
  industry: varchar("industry", { length: 30 }).notNull().default("restaurant"),
  location: varchar("location", { length: 128 }),
  language: varchar("language", { length: 8 }).notNull().default("en"),
  currency: varchar("currency", { length: 8 }).notNull().default("USD"),
  brand_style: jsonb("brand_style").$type<Record<string, unknown>>().notNull().default({}),
  schema_config: jsonb("schema_config").$type<Record<string, unknown>>().notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
  business_id: varchar("business_id", { length: 36 }).references(() => businesses.id),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 128 }),
  role: varchar("role", { length: 20 }).notNull().default("owner"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const roles = pgTable("roles", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 30 }).notNull(),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
});

export const userRoles = pgTable(
  "user_roles",
  {
    user_id: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
    role_id: varchar("role_id", { length: 36 }).notNull().references(() => roles.id),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.role_id] })]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull(),
    actor_id: varchar("actor_id", { length: 36 }),
    action: varchar("action", { length: 40 }).notNull(),
    entity: varchar("entity", { length: 40 }).notNull(),
    entity_id: varchar("entity_id", { length: 36 }),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("audit_logs_tenant_idx").on(table.tenant_id), index("audit_logs_entity_idx").on(table.entity)]
);

export const agentActions = pgTable(
  "agent_actions",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    user_id: varchar("user_id", { length: 36 }),
    session_id: varchar("session_id", { length: 128 }),
    turn_id: varchar("turn_id", { length: 128 }),
    tool_call_id: varchar("tool_call_id", { length: 128 }),
    agent: varchar("agent", { length: 64 }).notNull().default("business-agent"),
    tool: varchar("tool", { length: 128 }).notNull(),
    action: varchar("action", { length: 128 }).notNull(),
    input: jsonb("input").$type<Record<string, unknown>>(),
    result_summary: text("result_summary"),
    status: varchar("status", { length: 24 }).notNull(),
    error_code: varchar("error_code", { length: 64 }),
    started_at: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("agent_actions_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at),
    index("agent_actions_session_idx").on(table.session_id, table.created_at),
  ]
);

// ---------- 经营核心 ----------
export const products = pgTable(
  "products",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    name: varchar("name", { length: 128 }).notNull(),
    category: varchar("category", { length: 50 }).notNull().default("招牌菜"),
    price: numeric("price", { precision: 10, scale: 2 }).notNull().default("0"),
    cost: numeric("cost", { precision: 10, scale: 2 }).notNull().default("0"),
    stock: integer("stock").notNull().default(0),
    sales_count: integer("sales_count").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    description: text("description"),
    image_url: text("image_url"),
    video_url: text("video_url"),
    source: varchar("source", { length: 20 }).notNull().default("native"),
    external_id: varchar("external_id", { length: 128 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("products_category_idx").on(table.category),
    index("products_status_idx").on(table.status),
    index("products_tenant_business_idx").on(table.tenant_id, table.business_id),
    uniqueIndex("products_adapter_external_idx").on(table.tenant_id, table.business_id, table.source, table.external_id),
  ]
);

export const customers = pgTable(
  "customers",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    name: varchar("name", { length: 128 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    email: varchar("email", { length: 255 }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    total_spent: numeric("total_spent", { precision: 12, scale: 2 }).notNull().default("0"),
    visit_count: integer("visit_count").notNull().default(0),
    last_visit_at: timestamp("last_visit_at", { withTimezone: true }),
    ai_score: integer("ai_score"),
    churn_risk: varchar("churn_risk", { length: 20 }).notNull().default("low"),
    preference_notes: text("preference_notes"),
    source: varchar("source", { length: 20 }).notNull().default("native"),
    external_id: varchar("external_id", { length: 128 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("customers_churn_risk_idx").on(table.churn_risk),
    index("customers_last_visit_idx").on(table.last_visit_at),
    index("customers_business_idx").on(table.tenant_id, table.business_id),
    uniqueIndex("customers_adapter_external_idx").on(table.tenant_id, table.business_id, table.source, table.external_id),
  ]
);

export const orders = pgTable(
  "orders",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    order_no: varchar("order_no", { length: 40 }).notNull().unique(),
    customer_id: varchar("customer_id", { length: 36 }).references(() => customers.id),
    items: jsonb("items").$type<{ name: string; qty: number; price: number }[]>().notNull().default([]),
    total: numeric("total", { precision: 10, scale: 2 }).notNull().default("0"),
    tip: numeric("tip", { precision: 10, scale: 2 }).notNull().default("0"),
    tip_percent: numeric("tip_percent", { precision: 5, scale: 2 }),
    tip_staff_id: varchar("tip_staff_id", { length: 36 }),
    channel: varchar("channel", { length: 20 }).notNull().default("dine_in"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    source: varchar("source", { length: 20 }).notNull().default("native"),
    external_id: varchar("external_id", { length: 128 }),
    table_no: varchar("table_no", { length: 20 }),
    notes: text("notes"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("orders_customer_id_idx").on(table.customer_id),
    index("orders_status_idx").on(table.status),
    index("orders_created_at_idx").on(table.created_at),
    index("orders_source_external_idx").on(table.source, table.external_id),
    uniqueIndex("orders_adapter_external_idx").on(table.tenant_id, table.business_id, table.source, table.external_id),
    index("orders_business_created_idx").on(table.business_id, table.created_at),
  ]
);

// ---------- 评论 ----------
export const reviews = pgTable(
  "reviews",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    customer_id: varchar("customer_id", { length: 36 }).references(() => customers.id),
    author_name: varchar("author_name", { length: 128 }).notNull(),
    platform: varchar("platform", { length: 20 }).notNull().default("google"),
    rating: integer("rating").notNull().default(5),
    content: text("content").notNull(),
    sentiment: varchar("sentiment", { length: 20 }).notNull().default("positive"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    reply_content: text("reply_content"),
    reply_status: varchar("reply_status", { length: 20 }).notNull().default("none"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("reviews_customer_id_idx").on(table.customer_id),
    index("reviews_platform_idx").on(table.platform),
    index("reviews_status_idx").on(table.status),
    index("reviews_sentiment_idx").on(table.sentiment),
    index("reviews_business_created_idx").on(table.business_id, table.created_at),
  ]
);

// ---------- 邮件 ----------
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    provider: varchar("provider", { length: 20 }).notNull().default("smtp"),
    email: varchar("email", { length: 255 }).notNull(),
    display_name: varchar("display_name", { length: 128 }),
    auth_type: varchar("auth_type", { length: 20 }).notNull().default("password"),
    credentials_encrypted: text("credentials_encrypted"),
    smtp_host: varchar("smtp_host", { length: 255 }),
    smtp_port: integer("smtp_port"),
    imap_host: varchar("imap_host", { length: 255 }),
    imap_port: integer("imap_port"),
    is_default: boolean("is_default").notNull().default(false),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("email_accounts_status_idx").on(table.status),
    index("email_accounts_tenant_business_idx").on(table.tenant_id, table.business_id),
  ]
);

export const emails = pgTable(
  "emails",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    mailbox_id: varchar("mailbox_id", { length: 36 }).references(() => emailAccounts.id),
    from_addr: varchar("from_addr", { length: 255 }).notNull(),
    from_name: varchar("from_name", { length: 128 }),
    to_addr: varchar("to_addr", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 500 }).notNull(),
    content: text("content").notNull(),
    category: varchar("category", { length: 30 }).notNull().default("other"),
    priority: varchar("priority", { length: 20 }).notNull().default("medium"),
    ai_summary: text("ai_summary"),
    reply_draft: text("reply_draft"),
    status: varchar("status", { length: 20 }).notNull().default("unread"),
    external_id: varchar("external_id", { length: 255 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("emails_mailbox_id_idx").on(table.mailbox_id),
    index("emails_category_idx").on(table.category),
    index("emails_status_idx").on(table.status),
    index("emails_created_at_idx").on(table.created_at),
    index("emails_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at),
    uniqueIndex("emails_mailbox_external_idx").on(table.tenant_id, table.business_id, table.mailbox_id, table.external_id),
  ]
);

export const emailSendTasks = pgTable(
  "email_send_tasks",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    account_id: varchar("account_id", { length: 36 }).references(() => emailAccounts.id),
    content_id: varchar("content_id", { length: 36 }),
    campaign_id: varchar("campaign_id", { length: 36 }),
    approval_id: varchar("approval_id", { length: 36 }),
    execution_id: varchar("execution_id", { length: 36 }),
    to_addr: varchar("to_addr", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 500 }).notNull(),
    content: text("content").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    scheduled_at: timestamp("scheduled_at", { withTimezone: true }),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    failed_at: timestamp("failed_at", { withTimezone: true }),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(3),
    provider_message_id: varchar("provider_message_id", { length: 255 }),
    error: text("error"),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("email_send_tasks_account_idx").on(table.account_id),
    index("email_send_tasks_status_idx").on(table.status, table.scheduled_at),
    index("email_send_tasks_campaign_idx").on(table.tenant_id, table.business_id, table.campaign_id, table.status),
    index("email_send_tasks_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at),
  ]
);

// ---------- 知识库 ----------
export const knowledgeDocs = pgTable(
  "knowledge_docs",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    title: varchar("title", { length: 255 }).notNull(),
    category: varchar("category", { length: 30 }).notNull().default("sop"),
    content: text("content").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("ready"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("knowledge_docs_category_idx").on(table.category),
    index("knowledge_docs_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at),
  ]
);

export const docChunks = pgTable(
  "doc_chunks",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    doc_id: varchar("doc_id", { length: 36 }).notNull().references(() => knowledgeDocs.id, { onDelete: "cascade" }),
    chunk_index: integer("chunk_index").notNull().default(0),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("doc_chunks_doc_id_idx").on(table.doc_id),
    index("doc_chunks_tenant_business_idx").on(table.tenant_id, table.business_id, table.doc_id),
  ]
);

// ---------- AI 助手 ----------
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    user_id: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
    title: varchar("title", { length: 255 }).notNull().default("新会话"),
    summary: text("summary").notNull().default(""),
    summarized_message_count: integer("summarized_message_count").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("chat_sessions_tenant_business_user_idx").on(
      table.tenant_id, table.business_id, table.user_id, table.updated_at,
    ),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    user_id: varchar("user_id", { length: 36 }).notNull().references(() => users.id),
    session_id: varchar("session_id", { length: 36 }).notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content").notNull(),
    thinking: text("thinking"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("chat_messages_session_idx").on(table.session_id),
    index("chat_messages_created_idx").on(table.created_at),
    index("chat_messages_tenant_business_user_idx").on(
      table.tenant_id, table.business_id, table.user_id, table.created_at,
    ),
  ]
);

export const alerts = pgTable(
  "alerts",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    type: varchar("type", { length: 30 }).notNull().default("system"),
    level: varchar("level", { length: 20 }).notNull().default("info"),
    title: varchar("title", { length: 255 }).notNull(),
    content: text("content").notNull(),
    is_read: boolean("is_read").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("alerts_is_read_idx").on(table.is_read),
    index("alerts_created_at_idx").on(table.created_at),
    index("alerts_tenant_business_idx").on(table.business_id, table.created_at),
  ]
);

// ---------- 营销 ----------
export const marketingContents = pgTable(
  "marketing_contents",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    type: varchar("type", { length: 20 }).notNull().default("campaign"),
    title: varchar("title", { length: 255 }).notNull(),
    brief: text("brief"),
    content: text("content").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    send_stats: jsonb("send_stats").$type<{ total?: number; sent?: number; opened?: number }>(),
    approval_id: varchar("approval_id", { length: 36 }),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("marketing_contents_type_idx").on(table.type),
    index("marketing_contents_status_idx").on(table.status),
    index("marketing_contents_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at),
  ]
);

// ---------- 预约 ----------
export const reservations = pgTable(
  "reservations",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    customer_name: varchar("customer_name", { length: 128 }).notNull(),
    phone: varchar("phone", { length: 32 }).notNull(),
    party_size: integer("party_size").notNull().default(2),
    table_no: varchar("table_no", { length: 20 }),
    reserved_at: timestamp("reserved_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    source: varchar("source", { length: 20 }).notNull().default("phone"),
    notes: text("notes"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("reservations_reserved_at_idx").on(table.reserved_at),
    index("reservations_status_idx").on(table.status),
    index("reservations_tenant_business_idx").on(table.tenant_id, table.business_id, table.reserved_at),
  ]
);

// ---------- 点餐二维码（一桌一码） ----------
export const storeQrCodes = pgTable("store_qr_codes", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
  business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  table_no: varchar("table_no", { length: 20 }).notNull(),
  public_token: varchar("public_token", { length: 64 }).notNull().unique(),
  remark: varchar("remark", { length: 128 }),
  is_active: boolean("is_active").notNull().default(true),
  scan_count: integer("scan_count").notNull().default(0),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- 设置与集成 ----------
export const modelConfigs = pgTable(
  "model_configs",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    // 全局 unique 已移除：不同租户可配置同一 provider，由 (tenant_id, business_id, provider) 索引治理
    provider: varchar("provider", { length: 30 }).notNull(),
    api_key_encrypted: text("api_key_encrypted"),
    base_url: varchar("base_url", { length: 500 }),
    default_model: varchar("default_model", { length: 100 }),
    is_enabled: boolean("is_enabled").notNull().default(false),
    last_test_ok: boolean("last_test_ok"),
    last_tested_at: timestamp("last_tested_at", { withTimezone: true }),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    display_name: varchar("display_name", { length: 120 }),
    timeout_ms: integer("timeout_ms"),
    max_retries: integer("max_retries"),
    last_test_error: varchar("last_test_error", { length: 500 }),
    models_cache: jsonb("models_cache").$type<string[]>(),
    models_updated_at: timestamp("models_updated_at", { withTimezone: true }),
    opt_in_local: boolean("opt_in_local").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("model_configs_enabled_idx").on(table.is_enabled),
    uniqueIndex("model_configs_business_provider_idx").on(table.tenant_id, table.business_id, table.provider),
  ]
);

// ---------- AI 用量账本 ----------
export const aiUsageLedger = pgTable(
  "ai_usage_ledger",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }),
    business_id: varchar("business_id", { length: 36 }),
    user_id: varchar("user_id", { length: 36 }),
    agent: varchar("agent", { length: 60 }),
    provider: varchar("provider", { length: 40 }).notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    input_tokens: integer("input_tokens"),
    output_tokens: integer("output_tokens"),
    estimated_cost_usd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
    status: varchar("status", { length: 20 }).notNull().default("ok"),
    error_code: varchar("error_code", { length: 40 }),
    correlation_id: varchar("correlation_id", { length: 64 }).notNull(),
    latency_ms: integer("latency_ms"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_usage_ledger_tenant_idx").on(table.tenant_id, table.created_at),
    index("ai_usage_ledger_correlation_idx").on(table.correlation_id),
  ]
);

export const integrationConfigs = pgTable(
  "integration_configs",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    provider: varchar("provider", { length: 30 }).notNull(),
    config_encrypted: text("config_encrypted"),
    is_enabled: boolean("is_enabled").notNull().default(false),
    sync_scope: jsonb("sync_scope").$type<string[]>().notNull().default([]),
    last_sync_at: timestamp("last_sync_at", { withTimezone: true }),
    status: varchar("status", { length: 20 }).notNull().default("disconnected"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("integration_configs_enabled_idx").on(table.is_enabled),
    uniqueIndex("integration_configs_business_provider_idx").on(table.tenant_id, table.business_id, table.provider),
  ]
);

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    name: varchar("name", { length: 128 }).notNull(),
    category: varchar("category", { length: 50 }).notNull().default("食材"),
    unit: varchar("unit", { length: 20 }).notNull().default("kg"),
    current_stock: numeric("current_stock", { precision: 10, scale: 2 }).notNull().default("0"),
    safety_stock: numeric("safety_stock", { precision: 10, scale: 2 }).notNull().default("0"),
    supplier: varchar("supplier", { length: 128 }),
    erp_item_code: varchar("erp_item_code", { length: 64 }),
    synced_at: timestamp("synced_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("inventory_items_category_idx").on(table.category),
    index("inventory_items_business_idx").on(table.tenant_id, table.business_id),
  ]
);

export const settings = pgTable("settings", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
  business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  business: jsonb("business").$type<Record<string, unknown>>().notNull().default({}),
  locale: jsonb("locale").$type<Record<string, unknown>>().notNull().default({}),
  ai_prefs: jsonb("ai_prefs").$type<Record<string, unknown>>().notNull().default({}),
  model_assign: jsonb("model_assign").$type<Record<string, string>>().notNull().default({}),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("settings_tenant_business_idx").on(table.tenant_id, table.business_id),
]);

// ---------- 定时任务状态（轻量 KV，供 scheduler 记录推送水位线） ----------
export const cronState = pgTable("cron_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- 员工（用于小费归因，顾客下单后选择服务员工） ----------
export const staff = pgTable("staff", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
  business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
  name: varchar("name", { length: 128 }).notNull(),
  role: varchar("role", { length: 50 }),
  photo_url: text("photo_url"),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("staff_tenant_business_idx").on(table.tenant_id, table.business_id, table.is_active),
]);

// ---------- 企业长期记忆（AI COO 沉淀的经营事实/经验） ----------
export const businessMemories = pgTable(
  "business_memories",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    content: text("content").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("business_memories_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at)],
);

// ---------- Agent 持久化任务与运行记录 ----------
export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    task_type: varchar("task_type", { length: 64 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    schedule_cron: varchar("schedule_cron", { length: 64 }),
    status: varchar("status", { length: 24 }).notNull().default("active"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    next_run_at: timestamp("next_run_at", { withTimezone: true }),
    last_run_at: timestamp("last_run_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("agent_tasks_tenant_business_idx").on(table.tenant_id, table.business_id, table.status),
    index("agent_tasks_next_run_idx").on(table.next_run_at),
    uniqueIndex("agent_tasks_business_name_idx").on(table.business_id, table.name),
  ]
);

export const agentTaskRuns = pgTable(
  "agent_task_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    task_id: varchar("task_id", { length: 36 }).notNull().references(() => agentTasks.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    max_attempts: integer("max_attempts").notNull().default(3),
    idempotency_key: varchar("idempotency_key", { length: 255 }).notNull(),
    available_at: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    locked_by: varchar("locked_by", { length: 128 }),
    locked_at: timestamp("locked_at", { withTimezone: true }),
    claimed_by: varchar("claimed_by", { length: 128 }),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error_code: varchar("error_code", { length: 64 }),
    error: text("error"),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("agent_task_runs_task_idx").on(table.task_id, table.created_at),
    index("agent_task_runs_status_idx").on(table.status, table.available_at, table.locked_at),
    index("agent_task_runs_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at),
    uniqueIndex("agent_task_runs_idempotency_idx").on(table.idempotency_key),
  ]
);

// ---------- Agent 事件与通知 outbox ----------
export const agentEvents = pgTable(
  "agent_events",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    event_type: varchar("event_type", { length: 64 }).notNull(),
    severity: varchar("severity", { length: 24 }).notNull().default("info"),
    title: varchar("title", { length: 255 }).notNull(),
    content: text("content").notNull(),
    dedupe_key: varchar("dedupe_key", { length: 255 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("open"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    detected_at: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_events_business_dedupe_idx").on(table.business_id, table.dedupe_key),
    index("agent_events_tenant_business_status_idx").on(table.tenant_id, table.business_id, table.status, table.detected_at),
  ],
);

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    event_id: varchar("event_id", { length: 36 }).references(() => agentEvents.id),
    user_id: varchar("user_id", { length: 36 }),
    channel: varchar("channel", { length: 32 }).notNull(),
    notification_type: varchar("notification_type", { length: 64 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    content: text("content").notNull(),
    priority: varchar("priority", { length: 24 }).notNull().default("normal"),
    status: varchar("status", { length: 24 }).notNull().default("queued"),
    idempotency_key: varchar("idempotency_key", { length: 255 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(3),
    available_at: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    claimed_by: varchar("claimed_by", { length: 128 }),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    last_error: text("last_error"),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("notification_outbox_idempotency_idx").on(table.idempotency_key),
    index("notification_outbox_claim_idx").on(table.status, table.available_at, table.claimed_at),
    index("notification_outbox_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at),
  ],
);

// ---------- 消息通知（用于界面展示与通道分发） ----------
export const notifications = pgTable(
  "notifications",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    user_id: varchar("user_id", { length: 36 }),
    type: varchar("type", { length: 64 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    content: text("content").notNull(),
    priority: varchar("priority", { length: 24 }).notNull().default("normal"),
    status: varchar("status", { length: 24 }).notNull().default("unread"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("notifications_tenant_business_status_idx").on(table.tenant_id, table.business_id, table.status, table.created_at),
  ],
);

// ---------- PWA Web Push 订阅 ----------
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    user_id: varchar("user_id", { length: 36 }),
    endpoint: text("endpoint").notNull(),
    keys: jsonb("keys").$type<{ p256dh: string; auth: string }>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("push_subscriptions_tenant_business_idx").on(table.tenant_id, table.business_id),
    index("push_subscriptions_endpoint_idx").on(table.endpoint),
  ]
);

// ---------- Human-in-the-Loop 审批单 ----------
export const agentApprovals = pgTable(
  "agent_approvals",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    user_id: varchar("user_id", { length: 36 }),
    requester: varchar("requester", { length: 128 }),
    agent: varchar("agent", { length: 64 }).notNull().default("business-agent"),
    tool_name: varchar("tool_name", { length: 128 }),
    arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull().default({}),
    arguments_hash: varchar("arguments_hash", { length: 64 }),
    risk_level: varchar("risk_level", { length: 16 }).notNull().default("medium"),
    required_role: varchar("required_role", { length: 20 }).notNull().default("manager"),
    invocation_id: varchar("invocation_id", { length: 128 }).notNull(),
    execution_id: varchar("execution_id", { length: 36 }),
    approved_by: varchar("approved_by", { length: 36 }),
    action_type: varchar("action_type", { length: 64 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    rejected_at: timestamp("rejected_at", { withTimezone: true }),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    executed_at: timestamp("executed_at", { withTimezone: true }),
    failed_at: timestamp("failed_at", { withTimezone: true }),
    execution_result: jsonb("execution_result").$type<unknown>(),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("agent_approvals_tenant_business_idx").on(table.tenant_id, table.business_id, table.status),
    index("agent_approvals_status_created_idx").on(table.status, table.created_at),
    uniqueIndex("agent_approvals_invocation_idx").on(table.tenant_id, table.business_id, table.invocation_id),
  ]
);

// ---------- Production Audit Store（审批/工具执行的统一审计） ----------
export const auditEvents = pgTable(
  "audit_events",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    user_id: varchar("user_id", { length: 36 }),
    agent_id: varchar("agent_id", { length: 64 }),
    tool_name: varchar("tool_name", { length: 128 }),
    action: varchar("action", { length: 64 }).notNull(),
    arguments_hash: varchar("arguments_hash", { length: 64 }),
    approval_id: varchar("approval_id", { length: 36 }),
    execution_id: varchar("execution_id", { length: 36 }),
    result: jsonb("result").$type<unknown>(),
    actor_role: varchar("actor_role", { length: 20 }),
    status: varchar("status", { length: 24 }).notNull().default("ok"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_tenant_business_idx").on(table.tenant_id, table.business_id, table.created_at),
    index("audit_events_approval_idx").on(table.tenant_id, table.business_id, table.approval_id),
    index("audit_events_execution_idx").on(table.execution_id, table.action),
  ]
);

/** Provider-neutral webhook receipt ledger used before applying side effects. */
export const integrationEvents = pgTable(
  "integration_events",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    provider: varchar("provider", { length: 30 }).notNull(),
    external_event_id: varchar("external_event_id", { length: 255 }).notNull(),
    event_type: varchar("event_type", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("integration_events_provider_event_idx").on(
      table.tenant_id, table.business_id, table.provider, table.external_event_id,
    ),
  ],
);

// ---------- Payments (Stripe/PayPal lifecycle, separate from orders) ----------
export const payments = pgTable(
  "payments",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    provider: varchar("provider", { length: 20 }).notNull(),
    external_id: varchar("external_id", { length: 255 }),
    provider_payment_id: varchar("provider_payment_id", { length: 255 }),
    amount: numeric("amount", { precision: 14, scale: 3 }).notNull(),
    amount_minor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    description: varchar("description", { length: 200 }),
    reservation_id: varchar("reservation_id", { length: 36 }),
    order_id: varchar("order_id", { length: 36 }),
    checkout_url: text("checkout_url"),
    failure_reason: text("failure_reason"),
    refunded_amount_minor: bigint("refunded_amount_minor", { mode: "number" }).notNull().default(0),
    reconciled_at: timestamp("reconciled_at", { withTimezone: true }),
    created_by: varchar("created_by", { length: 36 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("payments_provider_external_idx").on(table.tenant_id, table.business_id, table.provider, table.external_id),
    uniqueIndex("payments_provider_payment_idx").on(table.tenant_id, table.business_id, table.provider, table.provider_payment_id),
    index("payments_tenant_status_idx").on(table.tenant_id, table.business_id, table.status, table.created_at),
  ],
);

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull().references(() => tenants.id),
    business_id: varchar("business_id", { length: 36 }).notNull().references(() => businesses.id),
    provider: varchar("provider", { length: 20 }).notNull(),
    external_event_id: varchar("external_event_id", { length: 255 }).notNull(),
    event_type: varchar("event_type", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("payment_events_provider_event_idx").on(table.tenant_id, table.business_id, table.provider, table.external_event_id),
  ],
);

// ---------- Platform Admin / SaaS Control Plane（平台级，无 tenant 归属） ----------
export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    email: varchar("email", { length: 255 }).notNull(),
    password_hash: text("password_hash").notNull(),
    name: varchar("name", { length: 120 }),
    role: varchar("role", { length: 30 }).notNull().default("admin"),
    is_active: boolean("is_active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    last_login_at: timestamp("last_login_at", { withTimezone: true }),
  },
);

export const platformAdminSessions = pgTable(
  "platform_admin_sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    admin_id: varchar("admin_id", { length: 36 }).notNull(),
    token_hash: varchar("token_hash", { length: 128 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("platform_admin_sessions_token_idx").on(table.token_hash)],
);

export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    slug: varchar("slug", { length: 60 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    price_amount: numeric("price_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    interval: varchar("interval", { length: 20 }).notNull().default("month"),
    features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
    is_active: boolean("is_active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("subscription_plans_slug_key").on(table.slug)],
);

export const tenantSubscriptions = pgTable(
  "tenant_subscriptions",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull(),
    plan_id: varchar("plan_id", { length: 36 }),
    status: varchar("status", { length: 20 }).notNull().default("trialing"),
    started_at: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    current_period_end: timestamp("current_period_end", { withTimezone: true }),
    grace_period_end: timestamp("grace_period_end", { withTimezone: true }),
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    renewal_source: varchar("renewal_source", { length: 30 }),
    provider_subscription_id: varchar("provider_subscription_id", { length: 120 }),
    amount: numeric("amount", { precision: 12, scale: 2 }),
    currency: varchar("currency", { length: 8 }).default("USD"),
    last_payment_status: varchar("last_payment_status", { length: 30 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("tenant_subscriptions_tenant_key").on(table.tenant_id)],
);

export const subscriptionEvents = pgTable(
  "subscription_events",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    event_key: varchar("event_key", { length: 120 }).notNull(),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull(),
    type: varchar("type", { length: 40 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("subscription_events_key").on(table.event_key)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull(),
    subscription_id: varchar("subscription_id", { length: 36 }),
    number: varchar("number", { length: 60 }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    provider_invoice_id: varchar("provider_invoice_id", { length: 120 }),
    issued_at: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
    paid_at: timestamp("paid_at", { withTimezone: true }),
  },
  (table) => [index("invoices_tenant_idx").on(table.tenant_id, table.issued_at)],
);

export const featureEntitlements = pgTable(
  "feature_entitlements",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }),
    feature: varchar("feature", { length: 80 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    rollout_percent: integer("rollout_percent").notNull().default(100),
    note: varchar("note", { length: 500 }),
    updated_by: varchar("updated_by", { length: 36 }),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const supportAccessGrants = pgTable(
  "support_access_grants",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    tenant_id: varchar("tenant_id", { length: 36 }).notNull(),
    admin_id: varchar("admin_id", { length: 36 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    read_only: boolean("read_only").notNull().default(true),
    starts_at: timestamp("starts_at", { withTimezone: true }).defaultNow().notNull(),
    ends_at: timestamp("ends_at", { withTimezone: true }).notNull(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("support_access_grants_idx").on(table.tenant_id, table.admin_id, table.ends_at)],
);

export const platformAdminAuditLogs = pgTable(
  "platform_admin_audit_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    admin_id: varchar("admin_id", { length: 36 }),
    action: varchar("action", { length: 80 }).notNull(),
    target_tenant_id: varchar("target_tenant_id", { length: 36 }),
    target_business_id: varchar("target_business_id", { length: 36 }),
    request_id: varchar("request_id", { length: 64 }),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("platform_admin_audit_idx").on(table.created_at)],
);
