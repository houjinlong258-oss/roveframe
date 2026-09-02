import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  index,
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

// ---------- 经营核心 ----------
export const products = pgTable(
  "products",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
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
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("products_category_idx").on(table.category), index("products_status_idx").on(table.status)]
);

export const customers = pgTable(
  "customers",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
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
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("customers_churn_risk_idx").on(table.churn_risk), index("customers_last_visit_idx").on(table.last_visit_at)]
);

export const orders = pgTable(
  "orders",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
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
  ]
);

// ---------- 评论 ----------
export const reviews = pgTable(
  "reviews",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
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
  ]
);

// ---------- 邮件 ----------
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
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
  (table) => [index("email_accounts_status_idx").on(table.status)]
);

export const emails = pgTable(
  "emails",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
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
  ]
);

export const emailSendTasks = pgTable(
  "email_send_tasks",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    account_id: varchar("account_id", { length: 36 }).references(() => emailAccounts.id),
    content_id: varchar("content_id", { length: 36 }),
    to_addr: varchar("to_addr", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 500 }).notNull(),
    content: text("content").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    scheduled_at: timestamp("scheduled_at", { withTimezone: true }),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("email_send_tasks_account_idx").on(table.account_id), index("email_send_tasks_status_idx").on(table.status)]
);

// ---------- 知识库 ----------
export const knowledgeDocs = pgTable(
  "knowledge_docs",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    title: varchar("title", { length: 255 }).notNull(),
    category: varchar("category", { length: 30 }).notNull().default("sop"),
    content: text("content").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("ready"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("knowledge_docs_category_idx").on(table.category)]
);

export const docChunks = pgTable(
  "doc_chunks",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    doc_id: varchar("doc_id", { length: 36 }).notNull().references(() => knowledgeDocs.id, { onDelete: "cascade" }),
    chunk_index: integer("chunk_index").notNull().default(0),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("doc_chunks_doc_id_idx").on(table.doc_id)]
);

// ---------- AI 助手 ----------
export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  title: varchar("title", { length: 255 }).notNull().default("新会话"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    session_id: varchar("session_id", { length: 36 }).notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content").notNull(),
    thinking: text("thinking"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("chat_messages_session_idx").on(table.session_id), index("chat_messages_created_idx").on(table.created_at)]
);

export const alerts = pgTable(
  "alerts",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    type: varchar("type", { length: 30 }).notNull().default("system"),
    level: varchar("level", { length: 20 }).notNull().default("info"),
    title: varchar("title", { length: 255 }).notNull(),
    content: text("content").notNull(),
    is_read: boolean("is_read").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("alerts_is_read_idx").on(table.is_read), index("alerts_created_at_idx").on(table.created_at)]
);

// ---------- 营销 ----------
export const marketingContents = pgTable(
  "marketing_contents",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    type: varchar("type", { length: 20 }).notNull().default("campaign"),
    title: varchar("title", { length: 255 }).notNull(),
    brief: text("brief"),
    content: text("content").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    send_stats: jsonb("send_stats").$type<{ total?: number; sent?: number; opened?: number }>(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("marketing_contents_type_idx").on(table.type), index("marketing_contents_status_idx").on(table.status)]
);

// ---------- 预约 ----------
export const reservations = pgTable(
  "reservations",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
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
  (table) => [index("reservations_reserved_at_idx").on(table.reserved_at), index("reservations_status_idx").on(table.status)]
);

// ---------- 点餐二维码（一桌一码） ----------
export const storeQrCodes = pgTable("store_qr_codes", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  table_no: varchar("table_no", { length: 20 }).notNull().unique(),
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
    provider: varchar("provider", { length: 30 }).notNull().unique(),
    api_key_encrypted: text("api_key_encrypted"),
    base_url: varchar("base_url", { length: 500 }),
    default_model: varchar("default_model", { length: 100 }),
    is_enabled: boolean("is_enabled").notNull().default(false),
    last_test_ok: boolean("last_test_ok"),
    last_tested_at: timestamp("last_tested_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("model_configs_enabled_idx").on(table.is_enabled)]
);

export const integrationConfigs = pgTable(
  "integration_configs",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    provider: varchar("provider", { length: 30 }).notNull().unique(),
    config_encrypted: text("config_encrypted"),
    is_enabled: boolean("is_enabled").notNull().default(false),
    sync_scope: jsonb("sync_scope").$type<string[]>().notNull().default([]),
    last_sync_at: timestamp("last_sync_at", { withTimezone: true }),
    status: varchar("status", { length: 20 }).notNull().default("disconnected"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("integration_configs_enabled_idx").on(table.is_enabled)]
);

export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
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
  (table) => [index("inventory_items_category_idx").on(table.category)]
);

export const settings = pgTable("settings", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  business: jsonb("business").$type<Record<string, unknown>>().notNull().default({}),
  locale: jsonb("locale").$type<Record<string, unknown>>().notNull().default({}),
  ai_prefs: jsonb("ai_prefs").$type<Record<string, unknown>>().notNull().default({}),
  model_assign: jsonb("model_assign").$type<Record<string, string>>().notNull().default({}),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- 定时任务状态（轻量 KV，供 scheduler 记录推送水位线） ----------
export const cronState = pgTable("cron_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- 员工（用于小费归因，顾客下单后选择服务员工） ----------
export const staff = pgTable("staff", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 128 }).notNull(),
  role: varchar("role", { length: 50 }),
  photo_url: text("photo_url"),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- 企业长期记忆（AI COO 沉淀的经营事实/经验） ----------
export const businessMemories = pgTable("business_memories", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  content: text("content").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
