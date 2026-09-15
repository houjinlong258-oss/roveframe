"""Agent → Toolset 映射解析（Step 1.75）。

问题
----
``api/app.py`` 的 ``/api/agent/chat`` 把 toolset **硬编码**为
``("safe", "memory", "business")``，与 ``req.agent`` 无关。后果：

- ``developer`` / ``devops`` 拿不到 ``file`` / ``terminal`` / ``process``
- Developer Agent 因此无法读写文件、无法跑测试（表现为「假响应」）
- 而 ``workforce/employees.py`` 里每个员工**早已声明**了自己的 ``tools`` 意图，
  只是从未被消费

本模块只解决这一件事：**服务端按 agent 身份推导 toolset 与迭代预算**。

设计原则（与 ``api/permissions.py`` 的 P0-11 同构）
---------------------------------------------------
1. **服务端权威**：客户端**不能**传 toolset。映射表是本模块的静态常量，
   请求体里即使带了 ``toolsets`` 字段也不会被读取（``ChatRequest`` 未定义该字段）。
2. **fail-closed**：未知 agent → 最小只读集合 ``DEFAULT_TOOLSETS``，
   绝不因为「没听说过」而放行更多能力。
3. **不扩大权限**：本模块只决定「把哪些工具**递到模型面前**」；
   工具**能否执行**由 ``EnterpriseToolGate`` 独立裁决（角色权限点 + 风险级 + 审批）。
   两层是**与**关系，不是替代关系。
4. **不改权限策略**：本模块不 import、不修改 ``tools/framework.py`` 的策略表。

注意
----
toolset 名必须在 ``toolsets.py`` 中真实存在，且其中的工具通过各自的
``check_fn`` 可用（缺凭据的工具会被 registry 过滤掉）。当前出厂态实测：
``file`` / ``terminal`` / ``todo`` / ``process`` / ``memory`` / ``business`` 可用，
``safe`` / ``coding`` / ``image_gen`` / ``search`` 因缺依赖或凭据而不可用 ——
``safe`` 的不可用会使其子项（web/vision/image_gen）一并消失，但不会报错。
"""
from __future__ import annotations

import logging
from typing import Final

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 映射表：agent key → (toolsets, max_iterations)
#
# agent key 与 roveagent/workforce/employees.py 的员工 key 对齐。
# ---------------------------------------------------------------------------
_AGENT_RUNTIME: Final[dict[str, tuple[tuple[str, ...], int]]] = {
    # 高管/业务角色：只读分析 + 长期记忆 + 经营数据，无文件/终端
    "ceo": (("safe", "memory", "business"), 8),
    "operations": (("safe", "memory", "business"), 8),
    "marketing": (("safe", "memory", "business"), 8),
    # 开发：文件读写 + 终端 + 任务规划；16 轮预算（改代码要读→改→跑测试→再改）
    "developer": (("file", "terminal", "todo"), 16),
    # 运维：终端 + 任务规划；16 轮预算。
    #
    # 注意：`process` **不是**一个 toolset —— registry 实测
    # `registry.get_toolset_for_tool("process") == "terminal"`，
    # 即进程管理工具与 terminal 同属 `terminal` 工具集。
    # 因此这里不写 "process"（写进去是无效名，会被静默忽略）。
    "devops": (("terminal", "todo"), 16),
}

#: 未知 agent 的 fail-closed 兜底：最小只读集合 + 默认预算
#: （与 ``api/app.py`` 的 ``agent_chat(max_iterations=8)`` 原默认值一致）
DEFAULT_TOOLSETS: Final[tuple[str, ...]] = ("safe", "memory", "business")
DEFAULT_MAX_ITERATIONS: Final[int] = 8

#: 预算上限。防止映射表被误改成一个会烧钱的巨大值。
MAX_ITERATIONS_CEILING: Final[int] = 32

#: 客户端**无权**指定、必须由服务端推导的请求字段。
#:
#: ``ChatRequest`` 未定义这些字段，因此请求体里带了也不会被读取
#: （pydantic 默认忽略未声明字段）。此常量用于**显式记录契约**
#: 与测试断言，避免日后有人「顺手」把它们加进请求模型。
CLIENT_IGNORED_FIELDS: Final[frozenset[str]] = frozenset({
    "toolsets",
    "tools",
    "enabled_tools",
    "max_iterations",
    "model",
    "base_url",
    "api_key",
    "system",
})


def resolve_toolsets(agent_key: str) -> tuple[str, ...]:
    """按 agent 身份解析 toolset 列表。未知 agent → ``DEFAULT_TOOLSETS``。

    服务端权威：调用方不应把客户端提供的值传进来。
    """
    entry = _AGENT_RUNTIME.get((agent_key or "").strip().lower())
    if entry is None:
        return DEFAULT_TOOLSETS
    return entry[0]


def resolve_toolsets_for_request(
    agent_key: str,
    *,
    filter_unavailable: bool = True,
    capability_toolsets: tuple[str, ...] | None = None,
) -> tuple[tuple[str, ...], dict[str, object]]:
    """按 agent 解析 toolset，并（默认）过滤掉当前不可用的工具。

    返回 ``(直接可用的 toolset 名, 诊断信息)``。

    ``capability_toolsets``
        由 ``capability_router`` 提供的能力画像。**传入时优先于本模块的
        最小表** —— 调用方（``api/app.py``）据此使用 Phase 1 的完整能力画像，
        而本模块保持独立、可单测，且不反向依赖 router（避免循环 import）。

    为什么需要过滤（Phase 2a / R1）
    ------------------------------
    ``/api/agent/chat`` 把 toolset 名交给 ``AIAgent`` 后，**工具名**仍会各自
    再过一次 ``check_fn``。出厂态实测：``developer`` 需要
    ``read_file``/``write_file``/``patch``/``search_files``/``terminal``/
    ``process``/``todo``（全部可用，7/7），而 ``safe`` 里的
    ``vision_analyze``/``image_generate`` 缺凭据。

    两个后果：

    1. **组合 toolset 在 ``registry.get_available_toolsets()`` 里永远不出现**
       （该方法只按「注册条目自带的 toolset 字段」分组，纯组合 toolset 没有
       这样的条目），于是调用方**看不到** ``safe``/``media``/``git`` 存在 ——
       实测 ``safe`` 展开出 4 个真实工具、子项全可用，却仍报 unavailable。
    2. 若因此把这些 toolset 名从请求里剔除，agent 会**静默少给工具** ——
       正是「能力修好了却递不到模型」的机制。

    本函数据此做两件事：

    - **保留**已知 toolset 名（组合与否都保留），让既有注册与语义继续生效；
    - 用 ``capability_router`` 的工具级解析算出**真正可用**的工具清单，
      放进诊断信息。不可用的工具被逐条列出，便于运维看到缺口。

    ``filter_unavailable`` 置 False 时不过滤、行为与 Phase 1 完全一致
    （便于回滚与对照）。
    """
    from . import capability_router

    requested = (
        capability_toolsets
        if capability_toolsets is not None
        else resolve_toolsets(agent_key)
    )

    # Phase 8.1.5：并入动态能力带来的 toolset。
    #
    # 静态表只写死了出厂 toolset；沙箱加载的插件工具（toolset ``plugin``）注册在
    # registry 里，却因为 agent 的 toolset 列表从不提到它而**对模型不可见**。
    # 这里正是真实请求链路（``api/app.py`` 调用本函数）的合并点，能力注册中心
    # 也在这里生效 —— 因此本模块不需要知道任何具体能力来源。
    #
    # 失败方向是安全的：注册中心不可用时 extra 为空，行为与合并前完全一致。
    try:
        extra = capability_router.dynamic_toolsets(agent_key)
    except Exception as exc:  # noqa: BLE001 — 注册中心可选
        logger.debug("dynamic toolsets unavailable for %r: %s", agent_key, exc)
        extra = ()

    if extra:
        seen = {str(n).strip().lower() for n in requested}
        requested = tuple(requested) + tuple(
            n for n in extra if str(n).strip().lower() not in seen)

    available_tools, unavailable_tools = capability_router.resolved_available_tools(requested)

    diagnostics: dict[str, object] = {
        "agent": (agent_key or "").strip().lower(),
        "requested_toolsets": list(requested),
        "available_tools": list(available_tools),
        "unavailable_tools": list(unavailable_tools),
    }

    if not filter_unavailable:
        return requested, diagnostics

    # 只保留「至少能提供 1 个可用工具」的 toolset 名。
    usable: list[str] = []
    for name in requested:
        name_tools, _ = capability_router.resolved_available_tools((name,))
        if name_tools:
            usable.append(name)
    diagnostics["usable_toolsets"] = usable
    return (tuple(usable) if usable else requested), diagnostics


def resolve_max_iterations(agent_key: str) -> int:
    """按 agent 身份解析工具循环预算。未知 agent → ``DEFAULT_MAX_ITERATIONS``。"""
    entry = _AGENT_RUNTIME.get((agent_key or "").strip().lower())
    if entry is None:
        return DEFAULT_MAX_ITERATIONS
    return min(entry[1], MAX_ITERATIONS_CEILING)


def describe_runtime(agent_key: str) -> dict[str, object]:
    """诊断用：返回该 agent 的解析结果（不含任何凭据）。"""
    key = (agent_key or "").strip().lower()
    return {
        "agent": key,
        "known": key in _AGENT_RUNTIME,
        "toolsets": list(resolve_toolsets(key)),
        "max_iterations": resolve_max_iterations(key),
    }
