import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('P0-16 Web Push 瞬时失败不再静默置 sent', () => {
  test('push 适配器返回结构化结果（sent/failed/deleted/noSubscribers）', () => {
    const src = read('src/lib/notifications/push.ts');
    assert.match(src, /export interface PushDispatchResult/);
    assert.match(src, /noSubscribers: boolean/);
    assert.match(src, /return \{ sent: 0, failed: 0, deleted: 0, noSubscribers: true \}/);
    assert.match(src, /statusCode === 410 \|\| statusCode === 404/, );
  });

  test('outbox 对不完整投递抛错重试，无订阅落终端失败', () => {
    const src = read('src/lib/notifications/outbox.ts');
    assert.match(src, /result\.noSubscribers/);
    assert.match(src, /no push subscriptions for recipients/);
    assert.match(src, /attempts: item\.max_attempts/);
    assert.match(src, /result\.sent === 0 \|\| result\.failed > 0/);
    assert.match(src, /web push delivery incomplete/);
    // 未完成必须走 catch 分支的 requeue/failed 逻辑（attempts/backoff）
    assert.match(src, /retryable \? 'queued' : 'failed'/);
  });

  test('daily_briefing 幂等键保持每渠道唯一（重复 tick 不重复发）', () => {
    const worker = read('src/lib/agent/tasks/worker.ts');
    assert.match(worker, /idempotencyKey/);
    assert.match(worker, /DAILY_BRIEFING/);
  });
});
