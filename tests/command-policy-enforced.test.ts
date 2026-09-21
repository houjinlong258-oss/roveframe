import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 18 §4.3 —— 命令策略必须是 **enforce**，而且必须真的进容器。
 *
 * ## 为什么需要一条 TS 侧的守卫
 *
 * 这条安全决策的判定发生在 Python 侧（`roveagent/api/command_policy.py` +
 * `enterprise/gate_hook.py`），而**开关**在 `docker-compose.yml`。
 * 于是存在一个典型的静默失效：判定逻辑一直是对的，但变量没进容器
 * ⇒ 非只读命令照常执行，而测试全绿。
 *
 * 这个仓库已经因为"变量没进容器"栽过两次（Phase 15 §18.2 的
 * `ENCRYPTION_SECRET_PREVIOUS`、Phase 16 的平台回落变量），两次都是
 * compose 的**显式环境变量白名单**造成的。
 *
 * ## 实测证据（本轮，容器内）
 *
 *   · `/proc/1/environ` 有 `ROVEAGENT_COMMAND_POLICY=enforce`；
 *   · `command_policy_enabled()` → True；
 *   · 真实 gate 钩子 `enterprise_gate_middleware(tool_name='terminal', …)`：
 *     `rm -rf /data/tmp` → `command_policy_blocked`（日志 enforced=True）；
 *     `echo hi > /data/x.txt` → `command_policy_blocked`；
 *     只读的 `ls -la` 不被策略层拦（继续走到下一层 gate）；
 *   · **空值对照**：同一进程内把变量显式置空 → `enabled()=False`
 *     ⇒ 证明是变量在起作用，而不是别的什么在阻断。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function stripYamlComments(src: string): string {
  return src.replace(/^\s*#.*$/gm, '');
}

describe('命令策略：compose 必须真的把 enforce 注入运行时', () => {
  const compose = stripYamlComments(read('docker-compose.yml'));

  test('roveagent 服务的环境变量里有 ROVEAGENT_COMMAND_POLICY', () => {
    assert.match(
      compose,
      /ROVEAGENT_COMMAND_POLICY:\s*\$\{ROVEAGENT_COMMAND_POLICY:-enforce\}/,
      '缺失或默认值不为 enforce —— devops persona 的非只读命令会只被记录而不被阻断',
    );
  });

  test('默认值必须是 enforce（安全默认是"拦"，放行要显式声明）', () => {
    // 负向对照：`:-` 后为空或 false 的写法必须被这条正则拒绝
    const bad = 'ROVEAGENT_COMMAND_POLICY: ${ROVEAGENT_COMMAND_POLICY:-}';
    assert.doesNotMatch(bad, /:\-\s*enforce\}/);
    assert.match(compose, /:\-\s*enforce\}/);
  });

  test('注释掉的变量不算数（去掉注释后仍然命中）', () => {
    const commented = '# ROVEAGENT_COMMAND_POLICY: ${ROVEAGENT_COMMAND_POLICY:-enforce}';
    assert.doesNotMatch(stripYamlComments(commented), /ROVEAGENT_COMMAND_POLICY/);
    assert.match(compose, /ROVEAGENT_COMMAND_POLICY/);
  });
});

describe('命令策略：Python 侧的默认值语义不能被反过来', () => {
  const policy = read('roveagent/api/command_policy.py');

  test('command_policy_enabled 只认显式的真值，缺省为 False', () => {
    // 语义是"未设 ⇒ 不强制"，因此 compose 的默认值才是唯一的安全来源。
    // 这条断言钉住"判定函数没有变成默认 True"（那会让 enforce 一词失去意义）。
    assert.match(policy, /def command_policy_enabled\(\)/);
    assert.match(policy, /"enforce",\s*"1",\s*"true",\s*"yes",\s*"on"/);
  });

  test('命令策略层在 gate **之前**执行（顺序错就等于没执行）', () => {
    const hook = read('roveagent/enterprise/gate_hook.py');
    const policyIndex = hook.indexOf('command_policy_enabled()');
    const gateIndex = hook.indexOf('decision = get_gate().authorize(');
    assert.ok(policyIndex > 0 && gateIndex > 0, '两段代码都必须存在');
    assert.ok(policyIndex < gateIndex, '命令策略必须在 get_gate().authorize 之前');
  });

  test('策略层只对 terminal 工具生效（不对所有工具一刀切）', () => {
    const hook = read('roveagent/enterprise/gate_hook.py');
    assert.match(hook, /if tool_name == "terminal":/);
  });

  test('阻断时返回的是明确错误码，而不是静默放过', () => {
    const hook = read('roveagent/enterprise/gate_hook.py');
    assert.match(hook, /"error":\s*"command_policy_blocked"/);
    // 负向对照：任何"失败就继续执行"的写法都不能出现
    assert.doesNotMatch(hook, /command_policy_blocked[\s\S]{0,200}?next_call\(args\)/);
  });
});
