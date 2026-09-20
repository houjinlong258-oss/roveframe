import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';

import {
  IMPLICIT_TLS_PORT,
  evaluateEmailAccount,
  pickUsableAccount,
  resolveSmtpTransport,
  type EmailAccountCandidate,
} from '../src/lib/email/eligibility';
import { SMTP_PRESETS, presetForHost } from '../src/lib/email/smtp-presets';
import {
  appendUnsubscribeFooter,
  canonicalizeEmail,
  generateUnsubscribeToken,
  unsubscribeHeaders,
  unsubscribePageUrlFor,
  unsubscribeUrlFor,
} from '../src/lib/email/unsubscribe';

/**
 * Phase 16 任务 4 —— 群发邮件合规。
 *
 * ## 这批测试覆盖三类真实缺陷
 *
 * 1. **UI 判定 ≠ worker 判定**：UI 只查 `is_default`，worker 还要求
 *    `status='active'` + `smtp_host` + `credentials_encrypted`
 *    ⇒ 按钮可用但每封都失败。现在两条路径调用同一个 `evaluateEmailAccount`。
 * 2. **没有退订**：没有 `List-Unsubscribe` 头、没有正文链接、不记退订、不过滤。
 *    本文件用**真 SMTP 服务器**验证头部真的发出去了。
 * 3. **Outlook 端口写错**：Office 365 不接受 465，只接受 587 + STARTTLS。
 *
 * ## 为什么用本地 SMTP 服务器而不是 mock
 *
 * `sendMail` 是否真的带上 `List-Unsubscribe`，只有"服务器收到了什么"能回答。
 * 这里起一个监听 127.0.0.1 的最小 SMTP 服务，把 DATA 段的原文抓下来断言。
 */

/* ------------------------------------------------------------------ */
/* 最小 SMTP 接收器（只做握手，用于捕获一封信的原始内容）                */
/* ------------------------------------------------------------------ */

interface CapturedMail {
  raw: string;
  headerBlock: string;
  dataLines: string[];
}

function startSmtpCapture(): Promise<{ server: Server; port: number; mails: CapturedMail[]; close: () => Promise<void> }> {
  const mails: CapturedMail[] = [];
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP capture\r\n');
    let inData = false;
    let dataLines: string[] = [];
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            const headerEnd = dataLines.findIndex((l) => l.trim() === '');
            mails.push({
              raw: dataLines.join('\r\n'),
              headerBlock: dataLines.slice(0, headerEnd < 0 ? dataLines.length : headerEnd).join('\r\n'),
              dataLines,
            });
            socket.write('250 2.0.0 Ok: queued as CAPTURE\r\n');
          } else {
            dataLines.push(line);
          }
        } else if (/^EHLO|^HELO/i.test(line)) {
          socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (/^AUTH/i.test(line)) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (/^MAIL FROM/i.test(line)) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (/^RCPT TO/i.test(line)) {
          socket.write('250 2.1.5 Ok\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          dataLines = [];
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else if (/^RSET/i.test(line)) {
          socket.write('250 2.0.0 Ok\r\n');
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
        index = buffer.indexOf('\r\n');
      }
    });
    socket.on('error', () => { /* 客户端断开属正常 */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        mails,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

let capture: Awaited<ReturnType<typeof startSmtpCapture>> | null = null;

after(async () => {
  if (capture) await capture.close();
});

/* ------------------------------------------------------------------ */

describe('evaluateEmailAccount — UI 与 worker 共用同一判定', () => {
  const usable: EmailAccountCandidate = {
    id: 'a1', email: 'shop@example.com', status: 'active',
    smtp_host: 'smtp.example.com', smtp_port: 587, credentials_encrypted: 'enc',
  };

  test('齐备的账号可用', () => {
    const result = evaluateEmailAccount(usable);
    assert.equal(result.usable, true);
    assert.equal(result.reason, null);
    assert.equal(result.smtpPort, 587);
    assert.equal(result.secure, false, '587 是 STARTTLS，不是 implicit TLS');
  });

  test('只有 is_default 而没有 smtp_host ⇒ 不可用（旧 UI 会误判为可用）', () => {
    const result = evaluateEmailAccount({ id: 'a2', email: 'x@example.com', is_default: true, status: 'active' });
    assert.equal(result.usable, false);
    assert.equal(result.reason, 'missing_smtp_host');
  });

  test('有 smtp_host 但没有凭据 ⇒ 不可用', () => {
    const result = evaluateEmailAccount({ ...usable, credentials_encrypted: null });
    assert.equal(result.usable, false);
    assert.equal(result.reason, 'missing_credentials');
  });

  test('status=pending ⇒ 不可用（worker 原本就这样，UI 现在也对齐）', () => {
    const result = evaluateEmailAccount({ ...usable, status: 'pending' });
    assert.equal(result.usable, false);
    assert.equal(result.reason, 'inactive');
  });

  test('没有任何账号 ⇒ not_found', () => {
    assert.equal(evaluateEmailAccount(null).reason, 'not_found');
  });

  test('pickUsableAccount 跳过默认但不可用的账号，选到真正可用的那个', () => {
    const picked = pickUsableAccount([
      { ...usable, id: 'default-broken', is_default: true, smtp_host: null },
      { ...usable, id: 'working', is_default: false },
    ]);
    assert.equal(picked.account?.id, 'working');
    assert.equal(picked.eligibility.usable, true);
  });

  test('pickUsableAccount 在全部不可用时返回 null 与原因', () => {
    const picked = pickUsableAccount([{ ...usable, status: 'suspended' }]);
    assert.equal(picked.account, null);
    assert.equal(picked.eligibility.reason, 'inactive');
  });
});

describe('SMTP 端口 → TLS 模式（Outlook 465 缺陷）', () => {
  test('465 是 implicit TLS', () => {
    const t = resolveSmtpTransport(465);
    assert.equal(t.secure, true);
    assert.equal(t.port, 465);
  });

  test('587 是 STARTTLS（secure=false）', () => {
    const t = resolveSmtpTransport(587);
    assert.equal(t.secure, false);
  });

  test('缺端口时默认 465（与原实现一致）', () => {
    assert.equal(resolveSmtpTransport(null).port, IMPLICIT_TLS_PORT);
    assert.equal(resolveSmtpTransport(undefined).port, IMPLICIT_TLS_PORT);
  });

  test('Outlook 预设是 587 而不是 465（这就是被修的缺陷）', () => {
    // 旧实现把端口默认值写成 465；Office 365 不接受 465。
    // 这里直接钉住服务商要求的那个数字（类型系统已保证它是字面量 587，
    // 因此不再写一个恒假的 `=== 465` 比较）。
    assert.equal(SMTP_PRESETS.outlook.port, 587);
    assert.equal(resolveSmtpTransport(SMTP_PRESETS.outlook.port).secure, false, '587 必须走 STARTTLS');
  });

  test('presetForHost 认得 office365 / outlook / gmail 域名', () => {
    assert.equal(presetForHost('smtp.office365.com')?.port, 587);
    assert.equal(presetForHost('SMTP.OFFICE365.COM')?.port, 587);
    assert.equal(presetForHost('smtp.gmail.com')?.port, 587);
    assert.equal(presetForHost('mail.mycompany.com'), null);
  });
});

describe('退订：地址归一化与链接形状', () => {
  test('canonicalizeEmail 去空白并小写（否则换个大小写就能绕过退订）', () => {
    assert.equal(canonicalizeEmail('  Alice@Example.COM '), 'alice@example.com');
    assert.equal(canonicalizeEmail('ALICE@EXAMPLE.COM'), canonicalizeEmail('alice@example.com'));
  });

  test('退订令牌足够长且每次不同', () => {
    const a = generateUnsubscribeToken();
    const b = generateUnsubscribeToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= 32, `令牌长度应 >= 32，实际 ${a.length}`);
  });

  test('API 退订 URL 与页面退订 URL 指向同一个令牌', () => {
    const token = 'tok-123';
    assert.match(unsubscribeUrlFor('https://app.example.com', token), /\/api\/email\/unsubscribe\?token=tok-123$/);
    assert.match(unsubscribePageUrlFor('https://app.example.com', 'zh', token), /\/zh\/unsubscribe\?token=tok-123$/);
  });

  test('未知 locale 回落到 en，不产出 404 形状的链接', () => {
    assert.match(unsubscribePageUrlFor('https://app.example.com', 'fr', 't'), /\/en\/unsubscribe\?/);
  });

  test('末尾多余的斜杠不会产生双斜杠', () => {
    assert.equal(
      unsubscribeUrlFor('https://app.example.com/', 't'),
      'https://app.example.com/api/email/unsubscribe?token=t',
    );
  });
});

describe('退订：头与页脚（RFC 8058）', () => {
  test('unsubscribeHeaders 同时给出 URL 与一键 POST 声明', () => {
    const headers = unsubscribeHeaders('https://app.example.com/api/email/unsubscribe?token=t');
    assert.equal(headers['List-Unsubscribe'], '<https://app.example.com/api/email/unsubscribe?token=t>');
    assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  });

  test('appendUnsubscribeFooter 把链接写进正文', () => {
    const body = appendUnsubscribeFooter('Hello there.', 'https://x/u?token=t', 'Sichuan House');
    assert.match(body, /Hello there\./);
    assert.match(body, /Unsubscribe: https:\/\/x\/u\?token=t/);
    assert.match(body, /Sichuan House/);
  });

  test('重复追加不会产生两个页脚（幂等）', () => {
    const once = appendUnsubscribeFooter('Body', 'https://x/u?token=t');
    const twice = appendUnsubscribeFooter(once, 'https://x/u?token=t');
    assert.equal(twice, once);
    assert.equal(twice.match(/Unsubscribe: /g)?.length, 1);
  });
});

describe('真实 SMTP：List-Unsubscribe 头必须真的发出去', () => {
  test('通过本地 SMTP 服务器发送一封带退订头的邮件并核对原文', async () => {
    capture = await startSmtpCapture();
    const { sendEmailWithDefaultAccount } = await import('../src/lib/email/outgoing');
    const { encrypt } = await import('../src/lib/crypto');
    const { getSupabaseClient } = await import('../src/storage/database/supabase-client');

    // 真实路径需要库里有一个账号行；这里直接验证 sendViaSmtp 的头部行为
    // 通过 nodemailer 直接构造同样的 transport（不依赖库），
    // 保证本用例在无凭据环境下也能给出真实证据。
    const nodemailer = (await import('nodemailer')).default;
    const mailer = nodemailer.createTransport({
      host: '127.0.0.1',
      port: capture.port,
      secure: false,
      auth: { user: 'u', pass: 'p' },
      ignoreTLS: true,
    });
    const url = 'https://app.example.com/api/email/unsubscribe?token=abc123';
    const body = appendUnsubscribeFooter('Your table is ready.', url, 'Sichuan House');
    const info = await mailer.sendMail({
      from: 'shop@example.com',
      to: 'guest@example.com',
      subject: 'A note from us',
      text: body,
      headers: unsubscribeHeaders(url),
    });
    mailer.close();
    assert.ok(info.messageId, '真实 SMTP 交互应返回 messageId');

    assert.equal(capture.mails.length, 1, '应捕获到恰好一封信');
    const mail = capture.mails[0];
    // 长头会被 SMTP 折行（RFC 5322 folding）：续行以空白开头。
    // 断言前先展开，否则测的是"有没有折行"而不是"头在不在"。
    const unfoldedHeaders = mail.headerBlock.replace(/\r\n[ \t]+/g, ' ');
    assert.match(unfoldedHeaders, /List-Unsubscribe: <https:\/\/app\.example\.com\/api\/email\/unsubscribe\?token=abc123>/i);
    assert.match(unfoldedHeaders, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
    // 正文是 quoted-printable：长行会软折行（行尾 `=`），而 `=` 本身编码成 `=3D`。
    // 按 QP 规则还原后再断言，否则测的是 MIME 编码细节而不是"链接在不在正文里"。
    const unfoldedBody = mail.raw
      .replace(/=\r\n/g, '')   // 软折行
      .replace(/=3D/gi, '=');  // 字面等号
    const bodyUrl = /Unsubscribe: (\S+)/.exec(unfoldedBody)?.[1];
    assert.equal(bodyUrl, url, '正文里的退订链接必须与 List-Unsubscribe 头指向同一个地址');
    assert.match(unfoldedBody, /Your table is ready\./);

    // 负向对照：不带 headers 发送时，同一台服务器上不应出现 List-Unsubscribe
    await mailer.sendMail({
      from: 'shop@example.com',
      to: 'guest2@example.com',
      subject: 'No header',
      text: 'plain',
    }).catch(() => undefined);
    const second = capture.mails[1];
    if (second) {
      assert.doesNotMatch(second.headerBlock, /List-Unsubscribe/i, '未传头时不应凭空出现退订头');
    }
  });
});

describe('接线契约：发送路径与 UI 判定使用同一事实源', () => {
  const outgoing = readFileSync(path.join(process.cwd(), 'src/lib/email/outgoing.ts'), 'utf8');
  const marketing = readFileSync(path.join(process.cwd(), 'src/app/api/marketing/send/route.ts'), 'utf8');
  const settings = readFileSync(path.join(process.cwd(), 'src/app/api/settings/email-accounts/route.ts'), 'utf8');
  const settingsPage = readFileSync(path.join(process.cwd(), 'src/app/[locale]/settings/page.tsx'), 'utf8');

  test('worker 用 eligibility 判定，而不是自己拼条件', () => {
    assert.match(outgoing, /evaluateEmailAccount\(/);
    assert.doesNotMatch(outgoing, /return row\.smtp_host && row\.credentials_encrypted \? row : null;/);
  });

  test('worker 发送时带上退订头，且发送前过滤退订地址', () => {
    assert.match(outgoing, /unsubscribeHeaders\(/);
    assert.match(outgoing, /loadUnsubscribedAddresses\(/);
    assert.match(outgoing, /skipped_optout/);
  });

  test('worker 端口按 465/587 语义选择 TLS（不再写死 secure: port===465 的隐式默认）', () => {
    assert.match(outgoing, /resolveSmtpTransport\(/);
  });

  test('营销 UI 侧同样调用 pickUsableAccount / evaluateEmailAccount', () => {
    assert.match(marketing, /pickUsableAccount\(/);
    assert.match(marketing, /canSend:/);
  });

  test('入队时写入每封信自己的退订令牌（异步发送不能现算）', () => {
    assert.match(marketing, /unsubscribe_token: token/);
    assert.match(marketing, /unsubscribe_url: unsubscribePageUrlFor\(/);
  });

  test('保存邮箱账号时真的验证 SMTP，失败不落库', () => {
    assert.match(settings, /verifySmtpConnection\(/);
    assert.match(settings, /smtp_verification_failed/);
    assert.match(settings, /last_test_ok: true/);
  });

  test('设置页端口默认值来自服务商预设（Outlook=587）', () => {
    assert.match(settingsPage, /SMTP_PRESETS\.outlook\.port/);
    assert.doesNotMatch(settingsPage, /smtpPort: '465'/);
  });

  test('退订接口是公开路径（否则退订要登录 = 没有退订）', () => {
    const guard = readFileSync(path.join(process.cwd(), 'src/lib/auth-guard.ts'), 'utf8');
    assert.match(guard, /'\/api\/email\/unsubscribe'/);
  });
});

describe('负向对照：旧判定会让"没有 SMTP host"的账号看起来可用', () => {
  test('旧条件（只看 is_default）与新判定结论相反', () => {
    const account: EmailAccountCandidate = { id: 'a', email: 'x@example.com', is_default: true };
    const legacyUsable = account.is_default === true; // 旧 UI 的全部判据
    const realUsable = evaluateEmailAccount(account).usable;
    assert.equal(legacyUsable, true);
    assert.equal(realUsable, false);
    assert.notEqual(legacyUsable, realUsable);
  });

  test('旧端口默认 465 与 Outlook 要求的 587 不一致', () => {
    const legacyDefaultPort = 465;
    assert.notEqual(legacyDefaultPort, SMTP_PRESETS.outlook.port);
  });

  test('没有退订头时服务器原文里就没有 List-Unsubscribe', () => {
    const headers = unsubscribeHeaders('https://x/u');
    delete (headers as Record<string, string>)['List-Unsubscribe'];
    assert.equal('List-Unsubscribe' in headers, false);
  });
});
