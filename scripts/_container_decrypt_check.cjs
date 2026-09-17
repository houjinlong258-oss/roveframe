/**
 * Phase 15 — 容器内解密核验（在 web 容器里跑；密钥不出容器，不打印明文）。
 *
 * 目的：定位 `[agent/chat] memory extraction failed: Unsupported state or
 * unable to authenticate data` 到底是不是"已落库凭据的加密密钥变了"。
 *
 * 为什么放在容器内跑：`ENCRYPTION_SECRET` 只存在于容器的运行环境里，
 * 宿主机的 `scripts/deploy.env` 没有它。在容器内运行可以做到
 * **密钥不出容器**，也不需要把它回显到对话里。
 *
 * 复刻的是 `src/lib/crypto.ts` 的确切算法：
 *   key = sha256(secret)（32 字节），AES-256-GCM，密文格式 "<ivB64>.<tagB64>.<dataB64>"
 */
const crypto = require('node:crypto');

const URL_BASE = process.env.COZE_SUPABASE_URL;
const KEY = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.ENCRYPTION_SECRET;

function derive(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function tryDecrypt(payload, key) {
  const parts = String(payload).split('.');
  if (parts.length !== 3) return { ok: false, why: `字段段数=${parts.length}，不是 3 段密文格式` };
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]);
    // 只返回长度与是否像 JSON，绝不返回明文
    const text = out.toString('utf8');
    let shape = `明文长度 ${text.length}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') shape += `，JSON 键=[${Object.keys(parsed).join(',')}]`;
    } catch { /* not json */ }
    return { ok: true, shape };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

async function fetchRows() {
  const out = [];
  for (const [table, col] of [['model_configs', 'api_key_encrypted'], ['email_accounts', 'credentials_encrypted']]) {
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=id,${col}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) { out.push({ table, error: `HTTP ${res.status} ${await res.text()}` }); continue; }
    const rows = await res.json();
    for (const row of rows) out.push({ table, col, id: String(row.id), value: row[col] });
  }
  return out;
}

(async () => {
  console.log('='.repeat(74));
  console.log('Phase 15 — 容器内解密核验');
  console.log('='.repeat(74));
  console.log(`ENCRYPTION_SECRET 存在: ${Boolean(SECRET)} (长度 ${SECRET ? SECRET.length : 0})`);
  console.log(`ENCRYPTION_SECRET_PREVIOUS 存在: ${Boolean(process.env.ENCRYPTION_SECRET_PREVIOUS)}`);
  console.log('');

  const keys = [];
  if (SECRET) keys.push(['ENCRYPTION_SECRET', derive(SECRET)]);
  for (const [i, entry] of String(process.env.ENCRYPTION_SECRET_PREVIOUS || '').split(',').entries()) {
    const t = entry.trim();
    if (t) keys.push([`ENCRYPTION_SECRET_PREVIOUS[${i}]`, derive(t)]);
  }
  // R-03 之前的历史派生密钥：service_role_key 本身
  if (KEY) keys.push(['(历史) COZE_SUPABASE_SERVICE_ROLE_KEY', derive(KEY)]);
  keys.push(['(非生产) dev fallback "roveframe-dev-secret"', derive('roveframe-dev-secret')]);

  const rows = await fetchRows();
  const failures = [];
  let okCount = 0;

  for (const r of rows) {
    if (r.error) { console.log(`[${r.table}] ${r.error}`); continue; }
    if (r.value === null || r.value === undefined) {
      console.log(`[${r.table}] ${r.id.slice(0, 8)}…  ${r.col} = null`);
      continue;
    }
    console.log(`[${r.table}] ${r.id.slice(0, 8)}…  ${r.col}`);
    let solved = false;
    for (const [label, key] of keys) {
      const res = tryDecrypt(r.value, key);
      if (res.ok) {
        console.log(`      ✓ 可解密，密钥 = ${label}；${res.shape}`);
        okCount += 1;
        solved = true;
        break;
      }
    }
    if (!solved) {
      const first = tryDecrypt(r.value, keys[0][1]);
      failures.push(`${r.table}.${r.col} id=${r.id}`);
      console.log(`      ✗ 用全部 ${keys.length} 个候选密钥都无法解密（首因: ${first.why}）`);
    }
  }

  console.log('');
  console.log('='.repeat(74));
  console.log(`可解密 ${okCount} 行，失败 ${failures.length} 行`);
  if (failures.length) for (const f of failures) console.log(`  - ${f}`);
  else console.log('（无失败：已落库凭据与当前密钥匹配）');
  console.log('='.repeat(74));
})();
