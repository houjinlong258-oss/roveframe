"""RoveAgent Core — RoveFrame AI Business OS 的原生 AI 运行时内核。

RoveAgent Core 深度融合 RoveFrame 企业控制层：

    core/            Agent Loop / Context / Memory Manager / Skill 引擎 / 子代理并行
    state/           SQLite + FTS5 会话记忆搜索（+ enterprise_memory 分层租户记忆）
    tools/           130+ 工具 + framework.py 企业门控（Schema→权限→审批→审计）
    gateway/         渠道网关内核（plugins/platforms: telegram/discord/slack/… 23 平台）
    cron/            自然语言定时任务与例行工作
    providers/       多模型抽象（OpenAI / Claude / Gemini / DeepSeek / 本地模型）
    skills_library/  内置技能库（自学习闭环：创建→审计→改进→评估）
    enterprise/      审计与 Agent 注册   tenant/  多租户隔离
    permissions/     权限引擎            connectors/ POS 连接（Square/Toast/Clover）
    business/        经营数据层          agents/     AI 员工团队
    repair/          自愈闭环            deployment/ 一键部署

公共入口::

    from roveagent import RoveAgentKernel, EnterpriseToolGate, EnterpriseMemory

TS 侧集成：通过 ``roveagent.gateway.platforms.api_server`` 的 HTTP/webhook
接口通信，避免自研 TS↔Python IPC。
"""
from __future__ import annotations

__version__ = "1.0.0"
__product__ = "RoveAgent Core"
__all__ = [
    "RoveAgentKernel",
    "EnterpriseToolGate",
    "EnterpriseMemory",
    "__version__",
]


def __getattr__(name: str):
    # 延迟导入：保持 import roveagent 轻量（重依赖按需加载）
    if name == "RoveAgentKernel":
        from .kernel import RoveAgentKernel
        return RoveAgentKernel
    if name == "EnterpriseToolGate":
        from .tools.framework import EnterpriseToolGate
        return EnterpriseToolGate
    if name == "EnterpriseMemory":
        from .state.enterprise_memory import EnterpriseMemory
        return EnterpriseMemory
    raise AttributeError(f"module 'roveagent' has no attribute {name!r}")
