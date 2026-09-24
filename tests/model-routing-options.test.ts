import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { chatModelOptions, type ProviderLike } from '../src/lib/ai/model-options';

/**
 * 「模型分流」只能列聊天模型 —— 一次真实故障的守卫。
 *
 * ## 故障现场（记录在 model-registry.ts 头注释）
 *
 * 用户的服务商 `/models` 里同时有 `agnes-image-2.0-flash`、`agnes-video-2.5-flash`。
 * Composer 把图像模型和聊天模型混在一起列出，用户把图像模型选来当聊天模型，
 * **每次请求必然 400**，白触发一次故障切换，账本里连续 4 条 provider_error。
 *
 * ## 这次要守的是什么
 *
 * 「模型分流」（每个能力用哪个模型）此前只列**每个供应商的一个默认模型**：
 *
 *     <option value={`${p.id}:${p.connection?.defaultModel}`}>{p.displayName}</option>
 *
 * 也就是说：模型列表已经能在保存时拉回来了，但**按能力分配的下拉里看不到它们**。
 * 用户的原话是「不是输入完这个模型供应商后生成所有模型列表，根据模型功能自己配置吗」。
 *
 * 改成按能力分组后，风险面与 Composer 相同：**必须只放行 chat**。
 * 本测试守住这条，并证明它能把「混进图像模型」的写法判红。
 */

/** 真实形态的供应商：一个聊天模型 + 一个图像模型 + 一个视频模型。 */
const provider: ProviderLike = {
  id: 'custom',
  displayName: '自定义',
  catalogModels: [],
  connection: { defaultModel: 'agnes-2.5-flash' },
  modelsCatalog: [
    { id: 'agnes-2.5-flash', capability: 'chat', strength: 'fast' },
    { id: 'agnes-3.0-flash', capability: 'chat', strength: 'general' },
    { id: 'agnes-image-2.0-flash', capability: 'image', strength: 'general' },
    { id: 'agnes-video-2.5-flash', capability: 'video', strength: 'general' },
  ],
};

describe('模型分流只列聊天模型', () => {
  test('分类可用时，图像/视频模型必须被排除', () => {
    const ids = chatModelOptions(provider).map((m) => m.id);
    assert.deepEqual(ids.sort(), ['agnes-2.5-flash', 'agnes-3.0-flash']);
    assert.equal(ids.includes('agnes-image-2.0-flash'), false, '图像模型不得进入聊天模型分流');
    assert.equal(ids.includes('agnes-video-2.5-flash'), false, '视频模型不得进入聊天模型分流');
  });

  test('强度标签随模型返回，供 UI 分组展示', () => {
    const byId = new Map(chatModelOptions(provider).map((m) => [m.id, m.strength]));
    assert.equal(byId.get('agnes-2.5-flash'), 'fast');
    assert.equal(byId.get('agnes-3.0-flash'), 'general');
  });

  test('服务端未给分类时退回默认模型 + 目录提示，且不倒出 modelsCache', () => {
    const legacy: ProviderLike = {
      id: 'legacy',
      displayName: '旧响应',
      catalogModels: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
      connection: { defaultModel: 'deepseek-v4-flash' },
      // 故意不给 modelsCatalog
    };
    const ids = chatModelOptions(legacy).map((m) => m.id).sort();
    assert.deepEqual(ids, ['deepseek-v4-flash', 'gpt-4o', 'gpt-4o-mini']);
    assert.equal(ids.length, 3, '不得把未分类的完整模型缓存倒进下拉');
  });

  test('没有连接也不报错（未配置任何供应商）', () => {
    const empty: ProviderLike = {
      id: 'x', displayName: 'X', catalogModels: [], connection: null,
    };
    assert.deepEqual(chatModelOptions(empty), []);
  });

  test('负向对照：混入非 chat 能力的实现必须被这条不变量判红', () => {
    // 模拟"把 modelsCatalog 全量倒进下拉"的错误实现
    const naive = (p: ProviderLike) => (p.modelsCatalog ?? []).map((m) => ({ id: m.id, strength: m.strength }));
    const naiveIds = naive(provider).map((m) => m.id);
    assert.equal(naiveIds.length, 4, '错误实现确实会列出全部 4 个模型');
    assert.ok(
      naiveIds.includes('agnes-image-2.0-flash'),
      '错误实现会把图像模型也列出来 —— 这正是断言要能抓住的差别，' +
        '说明「图像模型不得进入」这条断言不是空转的',
    );
    // 正确实现与之必须有可观测差异
    const correctIds = chatModelOptions(provider).map((m) => m.id);
    assert.notDeepEqual(correctIds.sort(), naiveIds.sort());
  });
});
