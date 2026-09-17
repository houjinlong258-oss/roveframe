/**
 * Phase 15 — 新注册商家的用户可见报错（真实 HTTP 路径）。
 *
 * ## 为什么单独验
 *
 * §20 的修复目标是：新商家（无 settings 行 ⇒ `model_assign` 视为 `auto`
 * ⇒ 走平台内置）在平台凭据未配置时，应当收到**可操作**的说明，
 * 而不是 SDK 的原始文案 `API key is required. Set COZE_API_TOKEN or provide apiKey in config`。
 *
 * 单测覆盖的是解析层；这里走真实 HTTP，看**最终抵达前端的事件**是什么。
 *
 * 判定标准（两条同时成立才算修好）：
 *   1. 返回的不是 SDK 原始文案；
 *   2. 返回的内容能告诉老板该做什么。
 */
const BASE = `http://127.0.0.1:${process.env.WEB_PORT || '5055'}`;
const CLIENT_IP = '203.0.113.30';

interface SseEvent { type?: string; [k: string]: unknown }

async function main(): Promise<number> {
  const stamp = Date.now();
  const email = `e2e-newtenant-${stamp}@example.com`;
  const password = `Rove!${stamp}Aa9`;

  console.log('='.repeat(78));
  console.log('Phase 15 — 新注册商家的用户可见报错');
  console.log('='.repeat(78));

  // 1) 注册（真实建 tenant + business + user，无 settings 行）
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify({
      email, password, business_name: `NewTenant ${stamp}`, industry: 'restaurant',
      language: 'en', currency: 'USD',
    }),
  });
  const cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  console.log(`注册: HTTP ${signup.status}`);
  if (signup.status !== 201) { console.log('注册失败，无法继续'); return 2; }

  // 2) 发一条**纯对话**（不要求工具）—— 这样才会走模型解析而不是被判定为工具任务
  const chat = await fetch(`${BASE}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': CLIENT_IP },
    body: JSON.stringify({ message: 'Hello, what can you do for my restaurant?', locale: 'en' }),
  });
  console.log(`chat: HTTP ${chat.status}`);

  const events: SseEvent[] = [];
  if (chat.body) {
    const reader = chat.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try { events.push(JSON.parse(payload) as SseEvent); } catch { /* skip */ }
      }
    }
  }

  const errEvent = events.find((e) => e.type === 'error');
  const noticeEvent = events.find((e) => e.type === 'notice');
  const runtimeStatus = events.find((e) => e.type === 'runtime_status');
  const text = events.filter((e) => e.type === 'delta').map((e) => String(e.text ?? '')).join('');

  console.log('');
  console.log(`事件类型: ${JSON.stringify(events.map((e) => e.type))}`);
  console.log(`runtime_status: ${JSON.stringify(runtimeStatus)}`);
  console.log(`error 事件: ${JSON.stringify(errEvent)}`);
  console.log(`notice 事件: ${JSON.stringify(noticeEvent)}`);
  console.log(`正文长度: ${text.length}`);
  console.log('');

  const blob = JSON.stringify({ errEvent, noticeEvent, text });
  const leaksSdkText = /Set COZE_API_TOKEN or provide apiKey in config/.test(blob);
  const actionable = /尚未配置 AI 服务商|接入一个模型服务商|ROVEFRAME_PLATFORM_LLM/.test(blob);
  const gotAnswer = text.length > 0 && !errEvent;

  console.log('='.repeat(78));
  console.log(`判定 1 —— 是否仍透出 SDK 原始文案: ${leaksSdkText ? '是 ✗（未修好）' : '否 ✓'}`);
  if (gotAnswer) {
    // 平台回落已配置凭据 ⇒ 走成功路径。此时"可操作报错"不应出现，出现反而是错的。
    console.log('判定 2 —— 平台回落是否真的可用: 是 ✓（新商家拿到了真实回复）');
    console.log(`           正文 ${text.length} 字符，无 error 事件`);
    console.log(`           注意：本路径下不应再出现"尚未配置 AI 服务商"提示（出现=${actionable ? '是 ✗' : '否 ✓'}）`);
  } else {
    console.log(`判定 2 —— 失败时是否给出可操作说明: ${actionable ? '是 ✓' : '否 ✗'}`);
  }
  console.log('');
  const pass = !leaksSdkText && (gotAnswer ? !actionable : actionable);
  console.log(`结论: ${pass ? '新商家路径正常（要么真的可用，要么失败时说清楚了原因）' : '修复未在用户可见路径生效'}`);
  console.log('='.repeat(78));
  return pass ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 1_500).unref(); })
  .catch((e: unknown) => { console.error('崩溃:', e); process.exitCode = 2; });
