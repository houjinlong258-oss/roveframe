/* eslint-disable no-console */
/**
 * 餐厅行业示例数据 seed 脚本
 * 用法: pnpm dlx tsx scripts/seed.ts        （已有数据时跳过）
 *       pnpm dlx tsx scripts/seed.ts --force（清空后重新 seed）
 */
import { getSupabaseClient } from "../src/storage/database/supabase-client";
import { EmbeddingClient } from "coze-coding-dev-sdk";

const client = getSupabaseClient();
const FORCE = process.argv.includes("--force");

const now = Date.now();
const daysAgo = (d: number, h = 12) => new Date(now - d * 86400000 - h * 3600000).toISOString();
const hoursFromNow = (h: number) => new Date(now + h * 3600000).toISOString();

async function tableCount(table: string): Promise<number> {
  const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`统计 ${table} 失败: ${error.message}`);
  return count ?? 0;
}

async function wipe() {
  const tables = [
    "doc_chunks", "chat_messages", "chat_sessions", "email_send_tasks", "emails", "email_accounts",
    "reviews", "orders", "reservations", "store_qr_codes", "marketing_contents", "alerts", "knowledge_docs",
    "inventory_items", "integration_configs", "model_configs", "products", "customers", "settings",
  ];
  for (const t of tables) {
    const { error } = await client.from(t).delete().not("id", "is", null);
    if (error) throw new Error(`清空 ${t} 失败: ${error.message}`);
  }
  console.log("已清空业务表");
}

async function main() {
  if ((await tableCount("products")) > 0 && !FORCE) {
    console.log("已有数据，跳过 seed（使用 --force 重新生成）");
    return;
  }
  if (FORCE) await wipe();

  // ---------- 设置 ----------
  const { error: e0 } = await client.from("settings").insert({
    business: {
      name: "Sichuan House 四川人家",
      industry: "restaurant",
      size: "10-30",
      hours: "11:00-22:00",
      timezone: "America/New_York",
      intro: "位于纽约的正宗川菜馆，主打现炒川味与手工小吃，提供堂食、外卖与网店零售。",
    },
    locale: { language: "en", currency: "USD", timezone: "America/New_York", ai_reply_language: "follow_customer" },
    ai_prefs: { style: "professional", auto_review_reply: true, churn_alert: true, daily_briefing: true },
    model_assign: { agent: "auto", content: "auto", rag: "auto" },
  });
  if (e0) throw new Error(`settings: ${e0.message}`);

  // ---------- 产品 ----------
  const products = [
    { name: "黑椒牛柳 Black Pepper Beef", category: "招牌菜", price: "68", cost: "28", stock: 45, sales_count: 328, status: "active" },
    { name: "水煮鱼 Boiled Fish in Chili Oil", category: "招牌菜", price: "88", cost: "36", stock: 30, sales_count: 286, status: "active" },
    { name: "宫保鸡丁 Kung Pao Chicken", category: "招牌菜", price: "38", cost: "14", stock: 60, sales_count: 412, status: "active" },
    { name: "麻婆豆腐 Mapo Tofu", category: "经典菜", price: "32", cost: "9", stock: 80, sales_count: 365, status: "active" },
    { name: "回锅肉 Twice-Cooked Pork", category: "经典菜", price: "42", cost: "16", stock: 50, sales_count: 243, status: "active" },
    { name: "夫妻肺片 Fuqi Feipian", category: "凉菜", price: "46", cost: "18", stock: 25, sales_count: 178, status: "active" },
    { name: "红糖糍粑 Brown Sugar Rice Cake", category: "小吃甜品", price: "18", cost: "5", stock: 90, sales_count: 298, status: "active" },
    { name: "手搓冰粉 Handmade Ice Jelly", category: "小吃甜品", price: "12", cost: "3", stock: 120, sales_count: 256, status: "active" },
    { name: "四川火锅底料 Hotpot Base (Retail)", category: "零售", price: "12.99", cost: "5.5", stock: 200, sales_count: 96, status: "active" },
    { name: "自制辣椒酱 Chili Sauce (Retail)", category: "零售", price: "8.99", cost: "3.2", stock: 180, sales_count: 74, status: "inactive" },
  ];
  const { error: e1 } = await client.from("products").insert(products);
  if (e1) throw new Error(`products: ${e1.message}`);

  // ---------- 客户 ----------
  const customers = [
    { name: "张伟 Wei Zhang", phone: "+1-917-555-0142", email: "wei.zhang@example.com", tags: ["堂食常客", "川菜爱好者"], total_spent: "2680", visit_count: 24, last_visit_at: daysAgo(38), ai_score: 62, churn_risk: "high", preference_notes: "偏爱黑椒牛柳、水煮鱼，不吃香菜；曾为企业客户" },
    { name: "Sarah Chen", phone: "+1-646-555-0198", email: "sarah.chen@example.com", tags: ["VIP", "高价值", "英文客户"], total_spent: "5420", visit_count: 42, last_visit_at: daysAgo(2), ai_score: 94, churn_risk: "low", preference_notes: "Kung Pao Chicken fan, prefers window seats, vegetarian options for her husband" },
    { name: "Mike Johnson", phone: "+1-212-555-0177", email: "mike.j@example.com", tags: ["新客"], total_spent: "86", visit_count: 1, last_visit_at: daysAgo(3), ai_score: 55, churn_risk: "medium", preference_notes: "First visit ordered Mapo Tofu, medium spice" },
    { name: "李芳 Fang Li", phone: "+1-347-555-0112", email: "fang.li@example.com", tags: ["外卖常客"], total_spent: "1890", visit_count: 31, last_visit_at: daysAgo(5), ai_score: 81, churn_risk: "low", preference_notes: "主要点外卖，常点宫保鸡丁套餐" },
    { name: "王强 Qiang Wang", phone: "+1-718-555-0163", email: "qiang.w@example.com", tags: ["家庭聚餐"], total_spent: "3240", visit_count: 18, last_visit_at: daysAgo(9), ai_score: 76, churn_risk: "medium", preference_notes: "周末家庭聚餐，需要儿童椅" },
    { name: "Emma Wilson", phone: "+1-917-555-0129", email: "emma.w@example.com", tags: ["VIP", "英文客户", "生日 6月"], total_spent: "4120", visit_count: 35, last_visit_at: daysAgo(1), ai_score: 91, churn_risk: "low", preference_notes: "Birthday in June, loves Boiled Fish, gluten-free request" },
    { name: "刘洋 Yang Liu", phone: "+1-646-555-0155", email: "yang.liu@example.com", tags: ["商务宴请"], total_spent: "6800", visit_count: 15, last_visit_at: daysAgo(14), ai_score: 88, churn_risk: "low", preference_notes: "公司宴请定点，需要包间，预算人均 ¥150" },
    { name: "陈静 Jing Chen", phone: "+1-212-555-0134", email: "jing.chen@example.com", tags: ["流失预警"], total_spent: "980", visit_count: 12, last_visit_at: daysAgo(45), ai_score: 48, churn_risk: "high", preference_notes: "曾每周光顾，近 45 天未到；喜欢红糖糍粑" },
    { name: "David Park", phone: "+1-347-555-0188", email: "david.park@example.com", tags: ["午餐常客"], total_spent: "1560", visit_count: 28, last_visit_at: daysAgo(4), ai_score: 79, churn_risk: "low", preference_notes: "Weekday lunch regular, quick service matters" },
    { name: "赵敏 Min Zhao", phone: "+1-718-555-0109", email: "min.zhao@example.com", tags: ["新客", "网店客户"], total_spent: "156", visit_count: 2, last_visit_at: daysAgo(6), ai_score: 58, churn_risk: "medium", preference_notes: "Shopify 购买火锅底料后到店一次" },
  ];
  const { data: custRows, error: e2 } = await client.from("customers").insert(customers).select("id, name");
  if (e2) throw new Error(`customers: ${e2.message}`);
  const cid = (name: string) => (custRows as { id: string; name: string }[]).find((c) => c.name.startsWith(name))?.id ?? null;

  // ---------- 订单 ----------
  const channels = ["dine_in", "takeout", "delivery", "square_pos", "shopify"];
  const orderSeeds: Record<string, unknown>[] = [];
  for (let i = 0; i < 42; i++) {
    const ch = channels[i % channels.length];
    const day = Math.floor(i / 6);
    const total = (32 + ((i * 37) % 140)).toFixed(2);
    orderSeeds.push({
      order_no: `#RF-${10240 + i}`,
      customer_id: cid(["张伟", "Sarah", "Mike", "李芳", "王强", "Emma", "刘洋", "陈静", "David", "赵敏"][i % 10]),
      items: [
        { name: "宫保鸡丁", qty: 1 + (i % 2), price: 38 },
        { name: "麻婆豆腐", qty: 1, price: 32 },
      ],
      total,
      channel: ch,
      status: i % 9 === 0 ? "pending" : i % 7 === 0 ? "processing" : "completed",
      source: ch === "square_pos" ? "square" : ch === "shopify" ? "shopify" : "native",
      external_id: ch === "square_pos" ? `SQ-${8840 + i}` : ch === "shopify" ? `SH-${2260 + i}` : null,
      created_at: daysAgo(day, (i * 3) % 10),
    });
  }
  const { error: e3 } = await client.from("orders").insert(orderSeeds);
  if (e3) throw new Error(`orders: ${e3.message}`);

  // ---------- 评论 ----------
  const reviews = [
    { customer_id: cid("陈静"), author_name: "陈静", platform: "google", rating: 2, content: "上周点的水煮鱼外卖送到时已经凉了，鱼肉也有点老。以前堂食体验很好，这次很失望。", sentiment: "negative", status: "pending", reply_status: "none", created_at: daysAgo(1) },
    { customer_id: cid("Sarah"), author_name: "Sarah Chen", platform: "google", rating: 5, content: "The Kung Pao Chicken here is the most authentic I've had in NYC. Staff remembered my husband's vegetarian preference. Will be back!", sentiment: "positive", status: "replied", reply_content: "Thank you so much, Sarah! We're thrilled you enjoyed the Kung Pao Chicken. We've noted the vegetarian preference for your next visit. See you soon!", reply_status: "published", created_at: daysAgo(2) },
    { customer_id: cid("Mike"), author_name: "Mike Johnson", platform: "yelp", rating: 4, content: "Solid Mapo Tofu with real numbing spice. Lunch was a bit slow (25 min wait for food) but quality made up for it.", sentiment: "positive", status: "replied", reply_content: "Thanks Mike! Sorry about the lunch wait — we've adjusted our kitchen scheduling. Hope to serve you faster next time.", reply_status: "published", created_at: daysAgo(3) },
    { customer_id: cid("李芳"), author_name: "李芳", platform: "facebook", rating: 3, content: "宫保鸡丁一如既往好吃，但这次外卖少送了一份米饭。客服处理还算及时。", sentiment: "neutral", status: "drafted", reply_content: "非常抱歉少送了米饭！我们已加强外卖打包复核流程。下次下单备注「老客补偿」，送您一份红糖糍粑。", reply_status: "draft", created_at: daysAgo(4) },
    { customer_id: cid("Emma"), author_name: "Emma Wilson", platform: "tripadvisor", rating: 5, content: "Best Boiled Fish outside of Chengdu! The chili oil is fragrant without being overwhelming. Gluten-free options clearly marked.", sentiment: "positive", status: "pending", reply_status: "none", created_at: daysAgo(1) },
    { customer_id: cid("王强"), author_name: "王强", platform: "google", rating: 4, content: "周末带家人来聚餐，包间环境不错，孩子也有儿童椅。夫妻肺片很地道，就是停车不太方便。", sentiment: "positive", status: "pending", reply_status: "none", created_at: daysAgo(5) },
    { customer_id: cid("赵敏"), author_name: "Min Zhao", platform: "yelp", rating: 5, content: "Bought their hotpot base online then visited in person. Both exceeded expectations. The ice jelly is a must-try!", sentiment: "positive", status: "pending", reply_status: "none", created_at: daysAgo(2) },
    { customer_id: cid("David"), author_name: "David Park", platform: "facebook", rating: 1, content: "Reserved a table for 12:30 but still waited 20 minutes. For a weekday lunch that's unacceptable when you only have an hour.", sentiment: "negative", status: "drafted", reply_content: "Hi David, sincerely apologize for the wait. We've now reserved buffer tables for weekday lunch bookings. Please show this reply next visit for a complimentary appetizer.", reply_status: "draft", created_at: daysAgo(6) },
  ];
  const { error: e4 } = await client.from("reviews").insert(reviews);
  if (e4) throw new Error(`reviews: ${e4.message}`);

  // ---------- 邮箱账户（示例，未配置凭据） ----------
  const { data: acctRows, error: e5 } = await client.from("email_accounts").insert({
    provider: "gmail",
    email: "hello@sichuanhouse.com",
    display_name: "Sichuan House",
    auth_type: "oauth",
    is_default: true,
    status: "pending_setup",
  }).select("id");
  if (e5) throw new Error(`email_accounts: ${e5.message}`);
  const acctId = (acctRows as { id: string }[])[0]?.id ?? null;

  // ---------- 邮件 ----------
  const emails = [
    { mailbox_id: acctId, from_addr: "catering@techcorp.com", from_name: "Lisa Wang", to_addr: "hello@sichuanhouse.com", subject: "Corporate catering inquiry — 40 people, June 28", content: "Hi, we're organizing a team dinner for ~40 people on June 28 at 6:30pm. Do you offer set menus for groups? Budget is around $45/person. We'd need 2-3 vegetarian options. Thanks!", category: "business", priority: "high", status: "unread", created_at: hoursFromNow(-3) },
    { mailbox_id: acctId, from_addr: "david.park@example.com", from_name: "David Park", to_addr: "hello@sichuanhouse.com", subject: "Feedback on yesterday's lunch wait", content: "I reserved 12:30 but waited 20 min. I only have an hour for lunch. Please do better.", category: "complaint", priority: "high", status: "unread", created_at: hoursFromNow(-6) },
    { mailbox_id: acctId, from_addr: "supplier@freshfarm-ny.com", from_name: "FreshFarm Wholesale", to_addr: "hello@sichuanhouse.com", subject: "Price update: Snakehead fish & yam, effective July 1", content: "Dear customer, due to supply changes, snakehead fish will increase by 12% and yam by 8% starting July 1. New price list attached. Please confirm your standing order quantities.", category: "supplier", priority: "medium", status: "unread", created_at: hoursFromNow(-26) },
    { mailbox_id: acctId, from_addr: "emma.w@example.com", from_name: "Emma Wilson", to_addr: "hello@sichuanhouse.com", subject: "Birthday dinner reservation request", content: "Hello! I'd like to book a table for 8 on June 21 (Saturday) at 7pm for my birthday. Any chance of the corner booth? Also do you do anything special for birthdays?", category: "inquiry", priority: "medium", status: "read", created_at: hoursFromNow(-30) },
    { mailbox_id: acctId, from_addr: "noreply@squareup.com", from_name: "Square", to_addr: "hello@sichuanhouse.com", subject: "Your daily sales summary is ready", content: "Your Square sales summary for yesterday is available: 46 transactions, $1,842.50 gross. View details in your Square Dashboard.", category: "other", priority: "low", status: "read", created_at: hoursFromNow(-32) },
    { mailbox_id: acctId, from_addr: "min.zhao@example.com", from_name: "赵敏", to_addr: "hello@sichuanhouse.com", subject: "辣椒酱什么时候补货？", content: "你好，我在你们网店买的火锅底料很好，想再买两瓶辣椒酱但显示缺货，请问什么时候能补货？", category: "inquiry", priority: "medium", status: "unread", created_at: hoursFromNow(-9) },
    { mailbox_id: acctId, from_addr: "events@nyfoodfest.com", from_name: "NY Food Fest", to_addr: "hello@sichuanhouse.com", subject: "Invitation: NYC Asian Food Festival vendor slot", content: "We're selecting 20 restaurants for the September Asian Food Festival (est. 15k visitors/day). Your restaurant came recommended. Vendor fee $800 for the weekend. Interested?", category: "business", priority: "medium", status: "unread", created_at: hoursFromNow(-14) },
    { mailbox_id: acctId, from_addr: "qiang.w@example.com", from_name: "王强", to_addr: "hello@sichuanhouse.com", subject: "发票申请", content: "你好，5 月 18 日家庭聚餐消费 ¥486，需要开发票，抬头：王强。谢谢。", category: "inquiry", priority: "low", status: "read", created_at: daysAgo(2) },
  ];
  const { error: e6 } = await client.from("emails").insert(emails);
  if (e6) throw new Error(`emails: ${e6.message}`);

  // ---------- 知识库文档 ----------
  const docs = [
    { title: "客诉处理标准流程 SOP", category: "sop", content: "一、响应时效：堂食投诉 5 分钟内响应，外卖/线上投诉 30 分钟内响应。二、处理步骤：1. 倾听并记录问题，不打断客户；2. 致歉并确认事实；3. 提出补救方案（重做/退款/赠菜，50 元以内员工可自主决定，超出需店长审批）；4. 记录到客诉日志；5. 24 小时内回访。三、升级机制：涉及食品安全、人身伤害、媒体曝光风险的立即上报店长和老板。四、禁止行为：不与客户争辩，不推卸责任给第三方平台，不承诺超出权限的赔偿。" },
    { title: "招牌菜产品知识手册", category: "product", content: "黑椒牛柳：选用牛里脊，黑胡椒现磨，腌制 20 分钟，大火快炒 90 秒，配彩椒洋葱。卖点：嫩滑多汁、黑椒香浓。推荐话术：我们的招牌，月售 300+ 份。水煮鱼：鲜活黑鱼现杀，片成 3mm 薄片，蛋清上浆；底料用二荆条+汉源花椒，滚油泼香。辣度可选微辣/中辣/特辣。宫保鸡丁：鸡腿肉切丁，花生米现炸，糊辣荔枝口，正宗川味不甜腻。麻婆豆腐：嫩豆腐焯水去腥，牛肉末炒酥，郫县豆瓣+豆豉，起锅撒花椒面与蒜苗。" },
    { title: "会员与储值政策", category: "policy", content: "会员等级：普通会员（消费即入会）、银卡（累计 2000）、金卡（累计 5000）、黑金（累计 15000）。权益：银卡 9.5 折，金卡 9 折+生日赠菜，黑金 8.5 折+专属包间+新品品鉴。储值：充 500 送 50，充 1000 送 120，充 3000 送 450。积分：消费 1 元=1 分，100 分抵 5 元。生日月双倍积分。退款规则：储值余额可退，按原路退回，赠送金额等比扣除。" },
    { title: "食品安全与后厨操作规范", category: "sop", content: "晨检：每日开店前检查冷藏温度（0-4°C）、冷冻温度（-18°C 以下）并记录。食材管理：生熟分开、荤素分池；叶菜浸泡 15 分钟；肉类中心温度 70°C 以上。效期：冷藏半成品 48 小时，酱料 7 天，开封调料标注日期。留样：每餐每菜留样 125g，冷藏 48 小时。健康：员工持健康证上岗，手部伤口必须戴手套。废弃物：餐厨垃圾当日清运，油水分离。" },
    { title: "外卖包装与出餐标准", category: "sop", content: "出餐时效：接单后 20 分钟内完成打包，超时主动致电客户说明。包装标准：汤菜分离，水煮鱼汤汁单独密封；热菜用铝箔保温盒；冰粉、凉菜用冷藏袋+冰袋。复核流程：一人装餐一人核对小票，米饭、餐具、赠品逐项勾选。差评预防：随餐附「满意卡」，引导不满意先联系门店。漏送处理：30 分钟内补送或退款，并赠送 20 元无门槛券。" },
    { title: "营销活动时间节点参考", category: "policy", content: "固定节点：春节（年夜饭套餐）、情人节（双人餐）、母亲节/父亲节（家庭餐）、暑期（学生优惠）、中秋（礼盒）、国庆、黑五（网店促销）、圣诞（派对餐）。日常节奏：周一至周四午市套餐引流；周五晚市推招牌菜；周末家庭聚餐场景。会员日：每月 18 日双倍积分。新品上市：提前 3 天社群预告+首日 8 折+邀请 KOC 试吃。淡季（1-2 月、7-8 月工作日）加大外卖满减力度。" },
  ];
  const { data: docRows, error: e7 } = await client.from("knowledge_docs").insert(docs).select("id, title, content");
  if (e7) throw new Error(`knowledge_docs: ${e7.message}`);

  // ---------- 文档分块 + 向量化 ----------
  console.log("生成知识库向量...");
  const embedder = new EmbeddingClient();
  const chunkRows: Record<string, unknown>[] = [];
  for (const doc of docRows as { id: string; title: string; content: string }[]) {
    const chunks = doc.content.match(/[^。；]{1,220}[。；]?/g) ?? [doc.content];
    for (let i = 0; i < chunks.length; i++) {
      const text = `${doc.title}：${chunks[i].trim()}`;
      const embedding = await embedder.embedText(text, { dimensions: 1024 });
      chunkRows.push({ doc_id: doc.id, chunk_index: i, content: text, embedding: JSON.stringify(embedding) });
    }
  }
  const { error: e8 } = await client.from("doc_chunks").insert(chunkRows);
  if (e8) throw new Error(`doc_chunks: ${e8.message}`);
  console.log(`已生成 ${chunkRows.length} 个向量分块`);

  // ---------- 会话 ----------
  const { data: sessRows, error: e9 } = await client.from("chat_sessions").insert([
    { title: "本周营收下滑分析" },
    { title: "午市套餐定价方案" },
  ]).select("id");
  if (e9) throw new Error(`chat_sessions: ${e9.message}`);
  const sess = sessRows as { id: string }[];

  const { error: e10 } = await client.from("chat_messages").insert([
    { session_id: sess[0].id, role: "user", content: "这周营收比上周下滑了 8%，帮我分析一下原因", created_at: daysAgo(1, 3) },
    { session_id: sess[0].id, role: "assistant", content: "我分析了近 14 天的订单数据，营收下滑主要来自三方面：\n\n**1. 外卖渠道下滑最明显（-15%）**\n本周外卖差评率上升至 8%，其中「配送变凉」相关差评 2 条，直接影响了平台流量推荐权重。建议优先处理陈静的那条 Google 差评。\n\n**2. 工作日午市客流减少（-9%）**\n周二至周四午市平均客流从 38 人降至 31 人。附近写字楼有公司团建外包给餐饮配送的竞争迹象。\n\n**3. 客单价微降（-2%）**\n新客占比提高但点单集中于低价套餐。\n\n**建议行动**：① 今日内回复 2 条外卖差评并补偿；② 推出工作日午市双人套餐；③ 针对 45 天未到的老客发送召回券。", created_at: daysAgo(1, 3) },
    { session_id: sess[1].id, role: "user", content: "帮我设计一个工作日午市套餐，客单价控制在 45 元左右", created_at: hoursFromNow(-5) },
    { session_id: sess[1].id, role: "assistant", content: "基于现有菜品毛利结构，推荐三套组合：\n\n**A 套「川味经典」¥42（毛利 62%）**\n宫保鸡丁 + 麻婆豆腐 + 米饭 + 例汤\n\n**B 套「招牌体验」¥48（毛利 58%）**\n小份黑椒牛柳 + 时蔬 + 米饭 + 冰粉\n\n**C 套「轻食单人」¥38（毛利 65%）**\n回锅肉 + 凉拌黄瓜 + 米饭\n\n建议主推 A 套，用 B 套做升级选项（加 ¥6 换购）。需要我把这三套方案生成营销海报文案吗？", created_at: hoursFromNow(-5) },
  ]);
  if (e10) throw new Error(`chat_messages: ${e10.message}`);

  // ---------- 告警 ----------
  const { error: e11 } = await client.from("alerts").insert([
    { type: "review", level: "warning", title: "新增 1 星差评待处理", content: "David Park 在 Facebook 留下 1 星评价：工作日午市等位 20 分钟。已生成回复草稿。", is_read: false, created_at: hoursFromNow(-8) },
    { type: "inventory", level: "warning", title: "3 项食材库存偏低", content: "黑鱼（8.5kg）、山药（5kg）、鲜牛肉（6kg）低于安全库存，周末前需补货。", is_read: false, created_at: hoursFromNow(-5) },
    { type: "inventory", level: "error", title: "茉莉花茶缺货", content: "库存为 0，影响冰粉与茶饮出品，建议今日下单采购。", is_read: false, created_at: hoursFromNow(-5) },
    { type: "customer", level: "info", title: "2 位老客流失风险", content: "张伟（38 天未到店）、陈静（45 天未到店）触发流失预警，可发送召回券。", is_read: false, created_at: hoursFromNow(-26) },
    { type: "lead", level: "info", title: "新的商机邮件", content: "TechCorp 40 人团餐询价（预算 $45/人），建议 24 小时内回复。", is_read: true, created_at: hoursFromNow(-3) },
  ]);
  if (e11) throw new Error(`alerts: ${e11.message}`);

  // ---------- 营销内容 ----------
  const { error: e12 } = await client.from("marketing_contents").insert([
    { type: "campaign", title: "工作日午市双人套餐推广", brief: "针对工作日午市客流下滑，推 ¥88 双人套餐", content: "【工作日午市双人套餐】\n\n忙碌的工作日，也要好好吃饭。\n\n招牌双人餐 ¥88（原价 ¥118）：\n· 宫保鸡丁 / 黑椒牛柳（二选一）\n· 麻婆豆腐\n· 时蔬一份\n· 米饭两碗 + 例汤两份\n\n周一至周五 11:00-14:00 供应，堂食专享。\n约上同事，20 分钟吃上正宗川味。", status: "published", created_at: daysAgo(3) },
    { type: "social", title: "周末招牌菜海报文案", brief: "周末营收冲刺，主推水煮鱼", content: "🐟 现杀黑鱼，滚油泼香\n这个周末，来一锅正经的水煮鱼\n\n📍 Sichuan House 四川人家\n⏰ 周末特供：水煮鱼双人份 ¥128，赠红糖糍粑\n\n#SichuanFood #NYCEats #WeekendVibes", status: "draft", created_at: daysAgo(1) },
    { type: "email", title: "老客召回邮件（张伟版）", brief: "45 天未到店老客召回", content: "Subject: 张伟，你的黑椒牛柳想你了\n\n张伟，你好：\n\n注意到你已经一个多月没来四川人家了。厨房的黑椒牛柳还是那个味道——牛里脊现切，黑胡椒现磨，大火 90 秒出锅。\n\n这周内回来，凭此邮件享招牌菜 8 折，另赠你爱的红糖糍粑一份。\n\n想你的，\n四川人家", status: "sent", send_stats: { total: 12, sent: 12, opened: 7 }, created_at: daysAgo(5) },
    { type: "email", title: "6 月会员日预告", brief: "每月 18 日双倍积分提醒", content: "Subject: This Saturday: Double Points Day + New Dish Tasting\n\nDear members,\n\nJune 18 is our monthly Members' Day:\n· Double points on all purchases\n· First taste of our new summer dish: Chilled Chicken with Chili Sauce\n· Gold & Black members: complimentary dessert\n\nBook your table now — Saturday fills up fast.", status: "draft", created_at: daysAgo(2) },
  ]);
  if (e12) throw new Error(`marketing_contents: ${e12.message}`);

  // ---------- 预约 ----------
  const todayAt = (h: number, m = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const { error: e13 } = await client.from("reservations").insert([
    { customer_name: "Emma Wilson", phone: "+1-917-555-0129", party_size: 8, table_no: "B1", reserved_at: todayAt(19), status: "confirmed", source: "google", notes: "Birthday dinner, corner booth requested" },
    { customer_name: "刘洋", phone: "+1-646-555-0155", party_size: 6, table_no: "B2", reserved_at: todayAt(19, 30), status: "confirmed", source: "phone", notes: "商务宴请，需要包间" },
    { customer_name: "Sarah Chen", phone: "+1-646-555-0198", party_size: 2, table_no: "A3", reserved_at: todayAt(18, 30), status: "confirmed", source: "website", notes: "Window seat" },
    { customer_name: "王强", phone: "+1-718-555-0163", party_size: 5, table_no: "A1", reserved_at: todayAt(12), status: "arrived", source: "phone", notes: "需要儿童椅" },
    { customer_name: "David Park", phone: "+1-347-555-0188", party_size: 2, table_no: "A1", reserved_at: todayAt(12, 30), status: "arrived", source: "google" },
    { customer_name: "李芳", phone: "+1-347-555-0112", party_size: 3, table_no: "A2", reserved_at: todayAt(20), status: "pending", source: "phone" },
    { customer_name: "赵敏", phone: "+1-718-555-0109", party_size: 4, table_no: "A4", reserved_at: todayAt(20, 30), status: "pending", source: "website", notes: "First visit" },
    { customer_name: "Mike Johnson", phone: "+1-212-555-0177", party_size: 2, table_no: "B6", reserved_at: todayAt(13), status: "completed", source: "google" },
  ]);
  if (e13) throw new Error(`reservations: ${e13.message}`);

  // ---------- 点餐二维码（一桌一码） ----------
  const { error: e13b } = await client.from("store_qr_codes").insert([
    { table_no: "A1", remark: "包间 · 靠窗" },
    { table_no: "A2", remark: "包间 · 中式屏风" },
    { table_no: "A3", remark: "包间 · 8 人圆桌" },
    { table_no: "A4", remark: "包间 · 安静角" },
    { table_no: "B1", remark: "大厅 · 靠窗双人" },
    { table_no: "B2", remark: "大厅 · 四人卡座" },
    { table_no: "B3", remark: "大厅 · 四人卡座" },
    { table_no: "B4", remark: "大厅 · 六人桌" },
    { table_no: "B5", remark: "大厅 · 六人桌" },
    { table_no: "B6", remark: "大厅 · 八人圆桌" },
    { table_no: "B7", remark: "大厅 · 吧台" },
    { table_no: "B8", remark: "大厅 · 吧台" },
  ]);
  if (e13b) throw new Error(`store_qr_codes: ${e13b.message}`);

  // ---------- 库存 ----------
  const { error: e14 } = await client.from("inventory_items").insert([
    { name: "鲜活黑鱼", category: "水产", unit: "kg", current_stock: "8.5", safety_stock: "15", supplier: "FreshFarm Wholesale", erp_item_code: "ITEM-FISH-001", synced_at: hoursFromNow(-1) },
    { name: "山药", category: "蔬菜", unit: "kg", current_stock: "5", safety_stock: "10", supplier: "FreshFarm Wholesale", erp_item_code: "ITEM-VEG-012", synced_at: hoursFromNow(-1) },
    { name: "鲜牛肉（里脊）", category: "肉类", unit: "kg", current_stock: "6", safety_stock: "12", supplier: "Prime Meats Co.", erp_item_code: "ITEM-MEAT-003", synced_at: hoursFromNow(-1) },
    { name: "茉莉花茶", category: "饮品原料", unit: "kg", current_stock: "0", safety_stock: "2", supplier: "Tea House Supply", erp_item_code: "ITEM-TEA-002", synced_at: hoursFromNow(-1) },
    { name: "鸡腿肉", category: "肉类", unit: "kg", current_stock: "22", safety_stock: "15", supplier: "Prime Meats Co.", erp_item_code: "ITEM-MEAT-007", synced_at: hoursFromNow(-1) },
    { name: "嫩豆腐", category: "豆制品", unit: "盒", current_stock: "48", safety_stock: "30", supplier: "Tofu Workshop", erp_item_code: "ITEM-SOY-001", synced_at: hoursFromNow(-1) },
    { name: "二荆条干辣椒", category: "调料", unit: "kg", current_stock: "9", safety_stock: "5", supplier: "Sichuan Spice Import", erp_item_code: "ITEM-SPICE-004", synced_at: hoursFromNow(-1) },
    { name: "汉源花椒", category: "调料", unit: "kg", current_stock: "4.5", safety_stock: "3", supplier: "Sichuan Spice Import", erp_item_code: "ITEM-SPICE-005", synced_at: hoursFromNow(-1) },
    { name: "大米（东北珍珠米）", category: "主食", unit: "kg", current_stock: "120", safety_stock: "50", supplier: "Grain Depot", erp_item_code: "ITEM-RICE-001", synced_at: hoursFromNow(-1) },
    { name: "鸡蛋", category: "蛋奶", unit: "板", current_stock: "15", safety_stock: "10", supplier: "FreshFarm Wholesale", erp_item_code: "ITEM-EGG-001", synced_at: hoursFromNow(-1) },
    { name: "彩椒", category: "蔬菜", unit: "kg", current_stock: "11", safety_stock: "8", supplier: "FreshFarm Wholesale", erp_item_code: "ITEM-VEG-020", synced_at: hoursFromNow(-1) },
    { name: "红糖", category: "甜品原料", unit: "kg", current_stock: "7", safety_stock: "4", supplier: "Baking Supply Co.", erp_item_code: "ITEM-SUG-003", synced_at: hoursFromNow(-1) },
  ]);
  if (e14) throw new Error(`inventory_items: ${e14.message}`);

  // ---------- 集成配置占位 ----------
  const { error: e15 } = await client.from("integration_configs").insert([
    { provider: "erpnext", is_enabled: false, status: "disconnected", sync_scope: ["inventory", "supplier", "purchase"] },
    { provider: "square", is_enabled: false, status: "disconnected", sync_scope: ["orders", "payments"] },
    { provider: "shopify", is_enabled: false, status: "disconnected", sync_scope: ["orders", "products"] },
    { provider: "stripe", is_enabled: false, status: "disconnected", sync_scope: ["payments", "reconciliation"] },
    { provider: "paypal", is_enabled: false, status: "disconnected", sync_scope: ["payments"] },
  ]);
  if (e15) throw new Error(`integration_configs: ${e15.message}`);

  console.log("Seed 完成：settings/products/customers/orders/reviews/emails/knowledge(+vectors)/chat/alerts/marketing/reservations/inventory/integrations");
}

main().catch((err) => {
  console.error("Seed 失败:", err);
  process.exit(1);
});
