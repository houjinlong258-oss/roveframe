import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { agentSseResponse } from '../src/app/api/agent/chat/route';

/**
 * Phase 12 / P1-6 —— 客户端断开必须中止上游生成。
 *
 * 在此之前，客户端断开只走到 `onSettled`（释放并发槽），**不会**停止
 * producer：用户关掉页面后上游 LLM 仍把整段回复生成完，算力与 provider
 * 额度照付，并发槽被一个没人要的结果占着。
 *
 * 这些是行为测试：真的建流、真的 cancel、真的断言信号被触发。
 */
describe('SSE client disconnect (P1-6)', () => {
  test('cancelling the stream aborts the producer signal', async () => {
    let captured: AbortSignal | null = null;
    let abortObserved = false;

    const response = agentSseResponse(async (emit, signal) => {
      captured = signal;
      emit({ type: 'status', phase: 'thinking' });
      // 模拟一个长时间运行的上游生成，只在被中止时结束。
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          abortObserved = true;
          resolve();
        });
        setTimeout(resolve, 5_000); // 兜底，避免测试挂死
      });
    });

    assert.ok(response.body, 'response 必须有 body');
    const reader = response.body!.getReader();
    await reader.read(); // 启动流
    await reader.cancel(); // 模拟客户端断开

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(captured, 'producer 必须收到 signal');
    assert.equal((captured as AbortSignal).aborted, true, 'preducer 的 signal 必须被中止');
    assert.equal(abortObserved, true, 'producer 必须观察到中止事件');
  });

  test('the producer signal starts un-aborted', async () => {
    let captured: AbortSignal | null = null;
    const response = agentSseResponse(async (_emit, signal) => {
      captured = signal;
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    assert.ok(captured);
    assert.equal((captured as AbortSignal).aborted, false, '正常完成的流不应被中止');
  });

  test('onSettled still runs exactly once on client disconnect', async () => {
    // 并发槽释放必须仍然可靠 —— 这是之前修过的 P0 回归点
    // （曾导致商户 4 条消息后永久 429）。
    let settled = 0;
    const response = agentSseResponse(
      async (emit, signal) => {
        // 必须先 emit 一次：否则第一个 reader.read() 会一直挂起，
        // reader.cancel() 根本执行不到，测试会静默退化成"等 5 秒兜底定时器"
        // —— 即测的不是断开路径。（实测该写法耗时 5.1s 且未覆盖目标分支。）
        emit({ type: 'status', phase: 'thinking' });
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve());
          setTimeout(resolve, 5_000);
        });
      },
      () => {
        settled += 1;
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(settled, 1, 'onSettled 必须在断开路径上恰好执行一次');
  });

  test('a normal completion does not abort the signal', async () => {
    let captured: AbortSignal | null = null;
    let settled = 0;
    const response = agentSseResponse(
      async (emit, signal) => {
        captured = signal;
        emit({ type: 'delta', text: 'done' });
      },
      () => {
        settled += 1;
      },
    );
    const text = await new Response(response.body).text();
    assert.match(text, /\[DONE\]/, '正常流必须以 [DONE] 结束');
    assert.equal((captured as unknown as AbortSignal).aborted, false);
    assert.equal(settled, 1);
  });
});
