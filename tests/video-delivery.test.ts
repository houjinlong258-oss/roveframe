import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { outputUrlOf, terminalStatusOf, sniffVideoMime, isModelMismatch } from '../src/lib/ai/video-generation';
import { detectDeliverables } from '../src/lib/artifacts/deliverable';
import { mimeForFormat } from '../src/lib/artifacts/store';

/**
 * 视频产物进入文件中心 —— 三个实测出来的坑，每个都有守卫。
 *
 * ## 背景
 *
 * 运行时的 `video_generate` 工具把成片存在**运行时自己的磁盘**上，而文件中心在
 * web 进程里（docker 下还是另一个容器），拿不到那个路径。本仓库的既有先例是
 * **图片生成走 TS 侧**并入产物系统，视频照同一模式做。
 *
 * ## 三个坑（都是实测，不是推测）
 *
 * 1. **输出地址在任务对象的顶层 `url`**，不在 OpenAI 的 `data[].url`；
 *    而且该网关没有实现 `GET /videos/{id}/content`（实测 502 + HTML）。
 * 2. **请求必须带 `mode`**（LiteLLM 风格网关），不带就 400 `mode is required`。
 * 3. **「回答太短就不出文件」这条护栏会误伤媒体生成** —— 实测让 agent 出一张海报，
 *    模型只回了 9 个字，于是被 `deliver_skipped_short_answer` 挡掉，看起来像功能坏了。
 *    媒体生成的提示词来自**用户原话**，不该受这条约束。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('任务对象解析：输出地址与终态', () => {
  test('顶层 url 优先（本网关就是这种形状）', () => {
    const job = { id: 'task_1', status: 'completed', url: 'https://cdn.example/v.mp4' };
    assert.equal(outputUrlOf(job), 'https://cdn.example/v.mp4');
  });

  test('兼容 OpenAI 的 data[].url', () => {
    const job = { id: 't', status: 'completed', data: [{ url: 'https://cdn.example/a.mp4' }] };
    assert.equal(outputUrlOf(job), 'https://cdn.example/a.mp4');
  });

  test('两者都有时以顶层为准（实测该网关只给顶层）', () => {
    const job = { url: 'https://top/v.mp4', data: [{ url: 'https://data/v.mp4' }] };
    assert.equal(outputUrlOf(job), 'https://top/v.mp4');
  });

  test('负向对照：一个地址都没有时必须返回 null，不能猜', () => {
    assert.equal(outputUrlOf({ id: 't', status: 'completed' }), null);
    assert.equal(outputUrlOf({ data: [{}] }), null);
    assert.equal(outputUrlOf({ url: '' }), null);
    assert.equal(outputUrlOf(null), null);
  });

  test('终态判定：completed/succeeded 成功，failed/error/cancelled 失败，其余为进行中', () => {
    assert.equal(terminalStatusOf({ status: 'completed' }), 'succeeded');
    assert.equal(terminalStatusOf({ status: 'succeeded' }), 'succeeded');
    assert.equal(terminalStatusOf({ status: 'failed' }), 'failed');
    assert.equal(terminalStatusOf({ status: 'error' }), 'failed');
    assert.equal(terminalStatusOf({ status: 'CANCELLED' }), 'failed');
  });

  test('负向对照：queued / in_progress 必须判为「仍在进行」，否则会立刻误判失败', () => {
    assert.equal(terminalStatusOf({ status: 'queued' }), null);
    assert.equal(terminalStatusOf({ status: 'in_progress' }), null);
    assert.equal(terminalStatusOf({}), null);
    assert.equal(terminalStatusOf(null), null);
  });
});

describe('成片容器的魔数嗅探', () => {
  /** 造一个最小 MP4 头：4 字节长度 + 'ftyp' + brand */
  const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'latin1')]);
  const webm = () => Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);

  test('ftyp 魔数 → video/mp4', () => {
    assert.equal(sniffVideoMime(mp4()), 'video/mp4');
  });

  test('EBML 魔数 → video/webm', () => {
    assert.equal(sniffVideoMime(webm()), 'video/webm');
  });

  test('负向对照：PNG 与随机字节都不得被判成视频', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    assert.equal(sniffVideoMime(png), 'application/octet-stream');
    assert.equal(sniffVideoMime(Buffer.from('hello world!!')), 'application/octet-stream');
    assert.equal(sniffVideoMime(Buffer.alloc(0)), 'application/octet-stream');
  });
});

describe('视频格式进入产物体系', () => {
  test('MIME 表认得 mp4 与 webm', () => {
    assert.equal(mimeForFormat('mp4'), 'video/mp4');
    assert.equal(mimeForFormat('webm'), 'video/webm');
  });

  test('负向对照：未知扩展名仍然是 octet-stream（没有偷偷放宽）', () => {
    assert.equal(mimeForFormat('exe'), 'application/octet-stream');
    assert.equal(mimeForFormat('mov'), 'application/octet-stream');
  });

  test('明确要宣传片/成片会识别成 mp4', () => {
    for (const message of [
      '帮我做一个 30 秒的门店宣传片',
      '把这段内容做成短视频，导出 mp4',
      '给我一条广告片',
    ]) {
      const formats = detectDeliverables(message).map((r) => r.format);
      assert.ok(formats.includes('mp4'), `「${message}」应识别出 mp4，实际: ${formats.join(',')}`);
    }
  });

  test('负向对照：随便提到「视频」不该触发交付（bare=false）', () => {
    const formats = detectDeliverables('视频号怎么运营比较好').map((r) => r.format);
    assert.equal(formats.includes('mp4'), false, '聊天里提到视频不应产出成片文件');
  });
});

describe('候选轮换：只在「模型不接受本接口」时换下一个', () => {
  test('实测信号 invalid mode 判定为模型不匹配', () => {
    assert.equal(
      isModelMismatch('custom 400: {"code":"invalid_request","message":"invalid mode","data":{"param":"mode"}}'),
      true,
    );
  });

  test('unsupported / model_not_found 也算模型不匹配', () => {
    assert.equal(isModelMismatch('400 unsupported model'), true);
    assert.equal(isModelMismatch('model_not_found'), true);
    assert.equal(isModelMismatch('this model does not support video'), true);
  });

  test('负向对照：超时/鉴权/任务失败**不该**换模型（换也救不了，只会白烧额度）', () => {
    assert.equal(isModelMismatch('video job task_1 did not finish within 15 min'), false);
    assert.equal(isModelMismatch('401 unauthorized'), false);
    assert.equal(isModelMismatch('video job task_1 failed: {"error":"nsfw"}'), false);
    assert.equal(isModelMismatch('poll 502: <html>'), false);
    assert.equal(isModelMismatch(''), false);
  });

  test('轮换必须可见：deliver.ts 在换过模型时发出提示', () => {
    const deliver = read('src/lib/agent/deliver.ts');
    assert.match(deliver, /video_model_rotated/, '换模型必须产生可见提示，不能静默 fallback');
    assert.match(deliver, /video\.skipped/, '提示要带上换了哪些');
  });

  test('负向对照：没有 skipped 时不得发提示（避免正常路径刷噪音）', () => {
    const deliver = read('src/lib/agent/deliver.ts');
    assert.match(
      deliver,
      /if \(video\.skipped && video\.skipped\.length > 0\)/,
      '提示必须被 skipped 非空守卫，否则每次出片都会多一条无意义通知',
    );
  });
});

describe('交付链路与路由已经接上视频（静态守卫）', () => {
  const deliver = read('src/lib/agent/deliver.ts');
  const route = read('src/app/api/agent/chat/route.ts');

  test('deliver.ts 有 mp4 分支且调用了 generateVideo', () => {
    assert.match(deliver, /import \{ generateVideo \} from '@\/lib\/ai\/video-generation'/);
    assert.match(deliver, /request\.format === 'mp4'/, 'deliver.ts 必须有 mp4 分支');
    assert.match(deliver, /await generateVideo\(/, 'mp4 分支必须真的去出片');
    assert.match(deliver, /putArtifact\(/, '出片后必须落进产物系统');
  });

  test('媒体生成不受「回答太短」护栏限制', () => {
    assert.match(
      deliver,
      /mediaOnly[\s\S]{0,200}!mediaOnly && answer\.length < MIN_ANSWER_CHARS/,
      '图片/视频的提示词来自用户原话，不该被回答长度挡掉（实测踩过这个坑）',
    );
  });

  test('聊天路由为视频意图也构建模型注册表', () => {
    assert.match(route, /needsMedia/, '路由必须识别媒体意图');
    assert.match(
      route,
      /needsMedia[\s\S]{0,120}buildModelRegistry/,
      '视频请求也要构建注册表，否则交付层拿到空表只会报 no_video_model',
    );
  });

  test('负向对照：静态守卫能识别缺失（用合成源码验证判定式）', () => {
    const withoutBranch = deliver.replace(/request\.format === 'mp4'/g, 'request.format === "nope"');
    assert.equal(/request\.format === 'mp4'/.test(withoutBranch), false, '移除分支后判定式必须为假');
    const withoutMedia = route.replace(/needsMedia/g, 'needsImage');
    assert.equal(/needsMedia/.test(withoutMedia), false, '移除 needsMedia 后判定式必须为假');
  });
});
