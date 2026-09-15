"""Agent Capability Router —— agent → toolset 的**能力解析**（Phase 1）。

与 ``api/toolsets.py`` 的关系
----------------------------
``api/toolsets.py`` 是 Step 1.75 落地的**最小映射**（agent → toolset 名 + 迭代预算），
职责单一、已被测试锁定。本模块**不取代它**，而是在其上补两层：

1. **能力解析（resolution）**：把「agent 意图的 toolset 列表」解析成
   「模型实际能拿到的工具名集合」。用 ``toolsets.py`` 的 ``tools`` 声明
   **加上** registry 的 ``get_toolset_for_tool()`` 归属 —— 两者并集。
2. **漂移/可用性报告（diagnostics）**：明确指出
   - 哪些 toolset 名**没有任何已注册工具**（声明漂移）
   - 哪些工具因 ``check_fn`` 未通过而**当前不可用**（缺凭据/依赖）

为什么需要第 1 层（这不是过度设计，是被两个真实故障逼出来的）
-----------------------------------------------------------
- **`process` 不是 toolset**：它在 registry 里归属于 ``terminal``
  （``registry.get_toolset_for_tool("process") == "terminal"``）。
- **`search` 是声明漂移**：``TOOLSETS["search"]`` 声明了 ``web_search``，
  但 registry 里 ``web_search`` 的 toolset 是 ``web`` ——
  于是 ``search`` 这个 toolset **没有任何已注册工具**，
  实测不出现在 ``get_available_toolsets()`` 里。
  若某个 agent 被映射到 ``search``，它会**静默拿不到任何工具**，
  而调用方看不到任何错误。这正是本模块要消除的一类失败。

设计约束
--------
- **服务端权威**：本模块只接受 agent key，不接受客户端传入的 toolset。
- **不新增权限**：本模块只决定「把哪些工具递到模型面前」；
  工具**能否执行**仍由 ``EnterpriseToolGate`` 独立裁决。
- **不改 ``runtime.py``**：纯新增模块 + 调用方接线。

当前状态：本模块**尚未接到请求链路**（``api/app.py`` 仍走 ``api/toolsets.py``），
先以「可测试的能力解析器」形式落地，接线在 Phase 1 的下一步完成。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)
from typing import Final, Iterable

# ---------------------------------------------------------------------------
# 1. agent → 能力画像
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AgentCapability:
    """一个 agent 的能力画像。

    ``toolsets`` 全部走服务端常量；客户端无法影响。
    """
    agent: str
    role: str
    toolsets: tuple[str, ...]
    max_iterations: int
    #: 人类可读的「这个 agent 该会做什么」——用于诊断与审计，不参与授权
    summary: str


#: 能力画像表。顺序与 ``workforce/employees.py`` 的员工 key 对齐。
#:
#: 说明：这里刻意**不复用** ``api/toolsets.py`` 的表，而是给出更完整的
#: 「目标能力画像」。两者的一致性由测试锁定（见 ``capability_router_test.py``），
#: 避免出现两张表各说各话。
AGENT_CAPABILITIES: Final[dict[str, AgentCapability]] = {
    "ceo": AgentCapability(
        agent="ceo", role="executive",
        # knowledge：租户自有文档检索（只读、受运行上下文作用域约束），
        # 与既有的 business 读取同风险等级 —— CEO 回答「我们的退款政策是什么」
        # 必须能查到内部文档，而不是只能联网。
        toolsets=("safe", "memory", "business", "knowledge", "search"),
        max_iterations=8,
        summary="读取经营数据、内部知识库、记忆、联网检索；回答问题与出报告。不碰文件与终端。",
    ),
    "operations": AgentCapability(
        agent="operations", role="executive",
        # knowledge：运营流程、SOP、价目表等内部文档。
        toolsets=("safe", "memory", "business", "knowledge"),
        max_iterations=8,
        summary="日常运营：订单、库存、预约、差评与流程效率（可查内部知识库）。",
    ),
    "marketing": AgentCapability(
        agent="marketing", role="executive",
        # CMO：业务只读 + 内部知识库 + 检索趋势 + 生成媒体 + 社交发布（发布必须审批）
        # 注意必须并上 safe/memory/business —— Phase 1 是 Step 1.75 的**超集**，
        # 不得因为扩展能力而收回既有只读能力（由一致性测试锁定）。
        toolsets=("safe", "memory", "business", "knowledge", "search", "web", "media", "social"),
        max_iterations=8,
        summary="客户增长与留存：内部知识库与趋势检索、内容与媒体生成、社交发布（需审批）。",
    ),
    "developer": AgentCapability(
        agent="developer", role="engineering",
        # 读→分析→改→diff→审批→写→测试→提交
        toolsets=("file", "terminal", "todo", "git", "skills", "delegation"),
        max_iterations=16,
        summary="AI 软件工程师：读写代码、打补丁、跑测试、git 提交（写与提交需审批）。",
    ),
    "devops": AgentCapability(
        agent="devops", role="engineering",
        # terminal 已含 process；docker/monitoring 见 docker_read/monitoring
        toolsets=("terminal", "docker_read", "monitoring", "todo"),
        max_iterations=16,
        summary="AI 运维工程师：服务状态、日志、进程、容器只读巡检（生产变更需审批）。",
    ),
}

#: 未知 agent 的 fail-closed 兜底
DEFAULT_CAPABILITY: Final[AgentCapability] = AgentCapability(
    agent="(unknown)", role="unknown",
    toolsets=("safe", "memory", "business"),
    max_iterations=8,
    summary="未知 agent：仅最小只读集合。",
)

#: 迭代预算上限（防止映射表被误改）
MAX_ITERATIONS_CEILING: Final[int] = 32


def capability_for(agent_key: str) -> AgentCapability:
    """按 agent key 取能力画像。未知 agent → fail-closed 兜底。"""
    key = (agent_key or "").strip().lower()
    return AGENT_CAPABILITIES.get(key, DEFAULT_CAPABILITY)


def planned_toolsets(agent_key: str) -> tuple[str, ...]:
    """该 agent **意图**启用的 toolset 列表（未做可用性过滤）。"""
    return capability_for(agent_key).toolsets


def planned_max_iterations(agent_key: str) -> int:
    """该 agent 的迭代预算（带上限钳制）。"""
    return min(capability_for(agent_key).max_iterations, MAX_ITERATIONS_CEILING)


# ---------------------------------------------------------------------------
# 2. 解析：toolset → 工具名集合（registry 感知）
# ---------------------------------------------------------------------------

@dataclass
class ToolsetResolution:
    """一个 toolset 的解析结果。"""
    name: str
    #: 声明里的工具（``TOOLSETS[name]["tools"]``）
    declared: tuple[str, ...]
    #: registry 里归属于该 toolset 的工具
    registry_owned: tuple[str, ...]
    #: 声明 + registry 的并集（顺序稳定）
    tools: tuple[str, ...]
    #: 声明了但 registry 里不存在（拼写错误 / 未注册）
    unknown_tools: tuple[str, ...]
    #: 该 toolset 是否在 ``get_available_toolsets()`` 中（即 check_fn 全过）
    available: bool

    @property
    def drift(self) -> bool:
        """声明与 registry 不一致（说明这个 toolset 的接线有问题）。"""
        return bool(self.unknown_tools) or not self.registry_owned


def _expand_includes(name: str, seen: set[str]) -> list[str]:
    """递归展开 ``includes``，返回组合得到的工具名（去重、保序）。

    必须做环检测：``includes`` 是任意声明，写错会死循环。
    """
    from roveagent.toolsets import TOOLSETS

    if name in seen:
        return []
    seen.add(name)

    spec = TOOLSETS.get(name) or {}
    collected: list[str] = [str(t) for t in (spec.get("tools") or [])]
    for child in (spec.get("includes") or []):
        for tool in _expand_includes(str(child), seen):
            if tool not in collected:
                collected.append(tool)
    return collected


def resolve_toolset(name: str) -> ToolsetResolution:
    """解析单个 toolset（**含 includes 展开**）。

    惰性 import registry —— 避免 ``api`` 层在无工具环境下导入失败。
    """
    from roveagent.toolsets import TOOLSETS

    spec = TOOLSETS.get(name) or {}
    declared = tuple(str(t) for t in (spec.get("tools") or []))
    includes = tuple(str(i) for i in (spec.get("includes") or []))

    # includes 展开结果（组合型 toolset 的全部工具来源）
    included = tuple(_expand_includes(name, set()))

    registry_owned: tuple[str, ...] = ()
    available = False
    try:
        from roveagent.model_tools import get_available_toolsets
        from roveagent.tools.registry import registry

        owned = [
            tool for tool in registry.get_all_tool_names()
            if registry.get_toolset_for_tool(tool) == name
        ]
        registry_owned = tuple(sorted(owned))
        available = name in set(get_available_toolsets())
    except Exception:  # noqa: BLE001 — registry 不可用时退化为「仅声明」
        pass

    merged: list[str] = []
    for tool in (*declared, *registry_owned, *included):
        if tool not in merged:
            merged.append(tool)

    # 漂移判定只用 **直接声明** 对 registry；includes 是组合意图，不算漂移
    unknown = tuple(t for t in declared if t not in registry_owned) if registry_owned else ()

    return ToolsetResolution(
        name=name,
        declared=declared,
        registry_owned=registry_owned,
        tools=tuple(merged),
        unknown_tools=unknown,
        available=available,
    )


def resolve_toolsets(names: Iterable[str]) -> tuple[list[ToolsetResolution], list[str]]:
    """解析一组 toolset，返回 ``(解析结果, 去重后的工具名列表)``。"""
    resolutions: list[ToolsetResolution] = []
    tools: list[str] = []
    for name in names:
        resolution = resolve_toolset(name)
        resolutions.append(resolution)
        for tool in resolution.tools:
            if tool not in tools:
                tools.append(tool)
    return resolutions, tools


# ---------------------------------------------------------------------------
# 3. 诊断报告（给运维/审计看「为什么这个 agent 少工具」）
# ---------------------------------------------------------------------------

@dataclass
class CapabilityReport:
    agent: str
    known: bool
    summary: str
    max_iterations: int
    requested_toolsets: tuple[str, ...]
    #: 解析出的工具名（去重，含不可用）
    resolved_tools: tuple[str, ...]
    #: **当前真正可用**的工具（check_fn 通过）—— 模型实际能拿到的
    available_tools: tuple[str, ...] = field(default_factory=tuple)
    #: 当前不可用的工具（缺凭据/依赖，或声明漂移）—— 显式报告，不静默丢弃
    unavailable_tools: tuple[str, ...] = field(default_factory=tuple)
    #: toolset 名存在但没有任何已注册工具 → 静默失效
    empty_toolsets: tuple[str, ...] = field(default_factory=tuple)
    #: check_fn 未通过 → 当前不可用（通常是缺凭据）
    unavailable_toolsets: tuple[str, ...] = field(default_factory=tuple)
    #: 声明了但 registry 里没有的工具名
    unknown_tools: tuple[str, ...] = field(default_factory=tuple)


def resolved_available_tools(names: Iterable[str]) -> tuple[list[str], list[str]]:
    """解析一组 toolset，返回 ``(可用工具, 不可用工具)``。

    这是修 R1 的关键：``registry.get_available_toolsets()`` **只能**按
    「已注册条目自带的 ``toolset`` 字段」分组，而 ``safe`` / ``media`` /
    ``git`` / ``docker_read`` / ``monitoring`` / ``social`` 这些是
    ``TOOLSETS`` 里的**纯组合** toolset —— 它们没有任何自带该 toolset 名的
    注册条目，因此**永远不会**出现在可用列表里，哪怕子项全部可用。

    实测（Phase 1 快照）：``safe`` 展开出
    ``image_generate`` / ``vision_analyze`` / ``web_extract`` / ``web_search``
    四个真实工具，子项 ``web`` / ``vision`` / ``image_gen`` 也全部可用，
    但 ``safe`` 仍报 unavailable。

    本函数绕开那个分组语义，直接对**每个工具**做 ``check_fn`` 判定
    （与 ``get_tool_definitions`` 的暴露逻辑一致），因此组合与原子
    toolset 得到同等对待。返回的「不可用工具」用于把缺口**显式报告**给
    运维，而不是静默少给工具。
    """
    from roveagent.tools.registry import registry

    resolutions, tools = resolve_toolsets(names)
    del resolutions  # 只为拿合并后的工具名

    available: list[str] = []
    unavailable: list[str] = []
    for tool in tools:
        entry = registry.get_entry(tool)
        if entry is None:
            unavailable.append(tool)  # 未注册（声明漂移）
            continue
        check = getattr(entry, "check_fn", None)
        if check is None:
            available.append(tool)
            continue
        try:
            from roveagent.tools.registry import _check_fn_cached

            ok = bool(_check_fn_cached(check))
        except Exception:  # noqa: BLE001 — 探测失败按不可用处理（fail-closed）
            try:
                ok = bool(check())
            except Exception:  # noqa: BLE001
                ok = False
        (available if ok else unavailable).append(tool)
    return available, unavailable


def filter_available_tools(names: Iterable[str]) -> list[str]:
    """只返回当前真正可用的工具（R1 的落地入口）。"""
    return resolved_available_tools(names)[0]


def capability_report(agent_key: str) -> CapabilityReport:
    """给一个 agent 出完整的能力诊断报告。"""
    capability = capability_for(agent_key)
    resolutions, tools = resolve_toolsets(capability.toolsets)
    available_tools, unavailable_tools = resolved_available_tools(capability.toolsets)

    empty: list[str] = []
    unavailable_sets: list[str] = []
    unknown: list[str] = []
    for resolution in resolutions:
        if not resolution.tools:
            empty.append(resolution.name)
        elif not resolution.available:
            unavailable_sets.append(resolution.name)
        unknown.extend(resolution.unknown_tools)

    return CapabilityReport(
        agent=capability.agent,
        known=(agent_key or "").strip().lower() in AGENT_CAPABILITIES,
        summary=capability.summary,
        max_iterations=planned_max_iterations(agent_key),
        requested_toolsets=capability.toolsets,
        resolved_tools=tuple(tools),
        available_tools=tuple(available_tools),
        unavailable_tools=tuple(unavailable_tools),
        empty_toolsets=tuple(empty),
        unavailable_toolsets=tuple(unavailable_sets),
        unknown_tools=tuple(dict.fromkeys(unknown)),
    )


def reports_for_all_agents() -> list[CapabilityReport]:
    """全部已知 agent 的诊断报告（供 Plugin Center / 运维页展示）。"""
    return [capability_report(key) for key in AGENT_CAPABILITIES]


# ---------------------------------------------------------------------------
# 3. 动态能力合并（Phase 8.1.5）—— base + dynamic
# ---------------------------------------------------------------------------
# 背景：``AGENT_CAPABILITIES`` 是**静态表**，agent 只能拿到写死在表里的 toolset。
# 任何在运行时出现的能力 —— 沙箱加载的插件工具、新配置的媒体 provider、技能工具
# —— 都注册进了 tool registry，却因为「agent 的 toolset 列表从不提到它」而
# **对模型不可见**。这与 R39 是同一类失败，只是高了一层。
#
# 因此这里**扩展**既有解析器，不新建第二套：base（静态表）∪ dynamic（能力注册中心），
# 再走原有的工具级解析与可用性过滤。``AGENT_CAPABILITIES`` 一行未改 —— 动态能力
# 通过注册中心进入，而不是往硬编码表里塞新 toolset。


@dataclass(frozen=True)
class AgentCapabilitySet:
    """一个 agent 的最终可用工具集：静态基线 + 动态能力。"""

    agent: str
    known: bool
    base_toolsets: tuple[str, ...]
    dynamic_toolsets: tuple[str, ...]
    #: 合并后的 toolset 名，顺序稳定（base 在前，dynamic 去重追加）。
    toolsets: tuple[str, ...]
    available_tools: tuple[str, ...]
    unavailable_tools: tuple[str, ...]
    max_iterations: int
    summary: str = ""
    capabilities: tuple[dict[str, Any], ...] = ()

    @property
    def dynamic_only(self) -> tuple[str, ...]:
        """只由动态能力带来的工具。运维最关心这一项。"""
        base = set(self.available_tools) & set(self._base_available())
        return tuple(t for t in self.available_tools if t not in base)

    def _base_available(self) -> tuple[str, ...]:
        return resolved_available_tools(self.base_toolsets)[0]

    def as_dict(self) -> dict[str, Any]:
        return {
            "agent": self.agent,
            "known": self.known,
            "base_toolsets": list(self.base_toolsets),
            "dynamic_toolsets": list(self.dynamic_toolsets),
            "toolsets": list(self.toolsets),
            "available_tools": list(self.available_tools),
            "unavailable_tools": list(self.unavailable_tools),
            "max_iterations": self.max_iterations,
            "summary": self.summary,
            "capabilities": list(self.capabilities),
        }


def dynamic_toolsets(agent_key: str) -> tuple[str, ...]:
    """该 agent 由动态能力获得的 toolset 名（Phase 8.1.5）。

    注册中心不可用时返回空 —— 静态能力不受影响，这是安全的降级方向。
    """
    try:
        from .capability_registry import CAPABILITIES

        return CAPABILITIES.toolsets_for_agent(agent_key)
    except Exception as exc:  # noqa: BLE001 — 注册中心可选
        logger.debug("dynamic toolsets unavailable for %r: %s", agent_key, exc)
        return ()


def merged_toolsets(agent_key: str) -> tuple[str, ...]:
    """静态基线 ∪ 动态能力，去重且顺序稳定。

    顺序：base 在前（既有语义与优先级不变），动态 toolset 按名排序追加。
    """
    base = planned_toolsets(agent_key)
    seen = {str(n).strip().lower() for n in base}
    extra = [n for n in dynamic_toolsets(agent_key)
             if str(n).strip().lower() not in seen]
    return tuple(base) + tuple(extra)


def resolve_agent_capabilities(agent_key: str) -> AgentCapabilitySet:
    """解析 agent 的最终可用工具 —— 目标架构里的 Capability Resolver。

    ``Agent → Capability Resolver → Capability Registry → Tool Resolver``：
    这里是前两步；工具级解析复用本模块既有的 ``resolved_available_tools``。
    """
    from .capability_registry import CAPABILITIES

    capability = capability_for(agent_key)
    base_sets = planned_toolsets(agent_key)
    dynamic_sets = dynamic_toolsets(agent_key)
    combined = merged_toolsets(agent_key)

    available, unavailable = resolved_available_tools(combined)
    try:
        caps = tuple(c.as_dict() for c in CAPABILITIES.for_agent(agent_key))
    except Exception:  # noqa: BLE001 — 注册中心可选
        caps = ()

    return AgentCapabilitySet(
        agent=capability.agent,
        known=(agent_key or "").strip().lower() in AGENT_CAPABILITIES,
        base_toolsets=base_sets,
        dynamic_toolsets=dynamic_sets,
        toolsets=combined,
        available_tools=tuple(available),
        unavailable_tools=tuple(unavailable),
        max_iterations=planned_max_iterations(agent_key),
        summary=capability.summary,
        capabilities=caps,
    )
