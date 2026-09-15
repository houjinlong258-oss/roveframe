"""Command Policy Layer（Phase 3.1 / R16）—— 命令级安全策略。

问题（R16）
----------
`EnterpriseToolGate` 按**工具名**授权：``terminal`` 需要 ``admin:process``。
它无法区分 ``tasklist``（只读）与 ``taskkill /F``（破坏性）——
两者都是「调用 terminal」。于是「DevOps 只读」只能靠模型遵循指令，
不是物理约束。

本模块补上**命令级**判定。定位：
----
    Command Policy  →  EnterpriseToolGate  →  Execution
    （本模块，命令粒度）  （既有，工具粒度，**不改**）

**不替代 gate**：本模块只回答「这条命令属于哪一档」，
真正的放行/审批仍由 gate 决定。两者是**与**关系。

默认行为（重要）
----------------
``enforce=False``（默认）：**只分类、只审计、放行**——不改变任何既有行为。
``enforce=True``（显式开启）：破坏性命令在 gate 之前就被拒绝，
或转交审批（由调用方决定）。

这样设计的原因：本模块属于**新增安全层**。默认打开会静默改变既有
部署的放行结果，属于「改变安全模型」——必须先由部署方显式同意。

分类
----
- ``read``        ：只读查询（ps / tasklist / docker ps / docker logs /
                    systemctl status / df / free / logs …）
- ``mutate``      ：可逆变更（restart / stop / start / reload）
- ``destructive`` ：破坏性（kill / rm / rmdir / del / drop / truncate / mkfs）
- ``deploy``      ：部署类（deploy / kubectl apply / docker compose up / helm）
- ``unknown``     ：无法判定 → 按 fail-closed 视为 `mutate`（需审批）
"""
from __future__ import annotations

import logging
import os
import re
import shlex
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

__all__ = [
    "CommandClass",
    "CommandVerdict",
    "classify_command",
    "classify_commands",
    "command_policy_enabled",
    "READ_ONLY_CLASSES",
]

#: 命令分级
class CommandClass:
    READ = "read"
    MUTATE = "mutate"
    DESTRUCTIVE = "destructive"
    DEPLOY = "deploy"


#: 只读档（enforce 模式下唯一直接放行的档位）
READ_ONLY_CLASSES = frozenset({CommandClass.READ})


# ---------------------------------------------------------------------------
# 规则表：**顺序敏感，先命中先用**
#
# 只读规则必须在前面 —— 否则 `docker ps` 会被宽泛的 `docker` 变更规则捕获。
# ---------------------------------------------------------------------------
_READ_PATTERNS: tuple[re.Pattern[str], ...] = tuple(re.compile(p, re.I) for p in (
    # 进程 / 系统
    r"^\s*(ps|tasklist)\b",
    r"^\s*(top|htop)\b",
    r"^\s*uptime\b",
    r"^\s*(df|du)\b",
    r"^\s*free\b",
    r"^\s*(cat|head|tail|less|more)\b",
    r"^\s*(ls|dir|ll)\b",
    r"^\s*(whoami|id|hostname|uname|ver|systeminfo)\b",
    r"^\s*(date|env|printenv|set)\b",
    r"^\s*(wmic)\b.*\b(get|list)\b",
    r"^\s*(netstat|ss|lsof|ipconfig|ifconfig|ip)\b",
    # docker 只读
    r"^\s*docker\s+(ps|images|version|info|inspect|stats|top|port|history)\b",
    r"^\s*docker\s+logs\b",
    r"^\s*docker\s+compose\s+(ps|logs|config)\b",
    # 服务/日志只读
    r"^\s*systemctl\s+(status|show|list-units|list-unit-files|is-active|is-enabled)\b",
    r"^\s*sc\s+query\b",
    r"^\s*service\s+\S+\s+status\b",
    r"^\s*journalctl\b(?!.*\s(--vacuum|--rotate|--flush)\b)",
    r"^\s*(wevtutil)\s+qe\b",
    r"^\s*log\s+show\b",
    r"^\s*git\s+(status|log|diff|show|branch|remote|tag)\b",
    # 容器只读
    r"^\s*kubectl\s+(get|describe|logs|top)\b",
    r"^\s*helm\s+(list|status|get)\b",
))

_MUTATE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(re.compile(p, re.I) for p in (
    r"^\s*systemctl\s+(restart|stop|start|reload|enable|disable)\b",
    r"^\s*sc\s+(stop|start|config|delete)\b",
    r"^\s*service\s+\S+\s+(restart|stop|start|reload)\b",
    r"^\s*net\s+(stop|start)\b",
    r"^\s*pm2\s+(restart|stop|reload|start|delete)\b",
    r"^\s*supervisorctl\s+(restart|stop|start)\b",
    r"^\s*docker\s+(restart|stop|start|pause|unpause|kill|rm|rmi|prune)\b",
    r"^\s*docker\s+compose\s+(restart|stop|start|down|rm)\b",
    r"^\s*kubectl\s+(rollout|scale|delete|apply|patch|edit|drain|cordon)\b",
    r"^\s*git\s+(checkout|reset|revert|clean|stash\s+drop)\b",
    r"^\s*(chmod|chown|chgrp)\b",
    r"^\s*(mv|move|rename|ren)\b",
    r"^\s*(cp|copy)\b",
    r"^\s*(touch|mkdir|md)\b",
    r"^\s*(echo|printf)\b.*(>|>>)",
    r"^\s*set-content\b",
))

_DESTRUCTIVE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(re.compile(p, re.I) for p in (
    r"^\s*(kill|killall|pkill|taskkill)\b",
    r"^\s*(rm|rmdir|del|erase)\b",
    r"^\s*remove-item\b",
    r"^\s*shutil\.rmtree\b",
    r"^\s*truncate\b",
    r"^\s*dd\b",
    r"^\s*mkfs\b",
    r"^\s*(dropdb|dropdatabase)\b",
    r"^\s*(format|fdisk|diskpart)\b",
    r"^\s*shutdown\b",
    r"^\s*reboot\b",
    r"^\s*reg\s+delete\b",
    r"^\s*(userdel|groupdel)\b",
))

_DEPLOY_PATTERNS: tuple[re.Pattern[str], ...] = tuple(re.compile(p, re.I) for p in (
    r"^\s*(deploy|release)\b",
    r"^\s*docker\s+compose\s+up\b",
    r"^\s*docker\s+(run|push)\b",
    r"^\s*(terraform|pulumi)\s+(apply|destroy)\b",
    r"^\s*ansible-playbook\b",
    r"^\s*(capistrano|cap)\s+deploy\b",
    r"^\s*npm\s+(publish|run\s+deploy)\b",
    r"^\s*(kubectl)\s+apply\b",
    r"^\s*helm\s+(install|upgrade|uninstall)\b",
))


@dataclass
class CommandVerdict:
    """单条命令的判定结果。"""

    command: str
    #: read | mutate | destructive | deploy
    classification: str
    #: 命中的规则（正则源码），用于解释判定依据
    matched_rule: Optional[str] = None
    #: 是否只读（enforce 唯一放行档）
    read_only: bool = False
    #: 判定依据说明
    reason: str = ""
    #: 复合命令（; && || |）被拆开后逐段的判定
    segments: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def requires_approval(self) -> bool:
        return not self.read_only

    def as_dict(self) -> Dict[str, Any]:
        return {
            "command": self.command,
            "classification": self.classification,
            "read_only": self.read_only,
            "matched_rule": self.matched_rule,
            "reason": self.reason,
            "segments": list(self.segments),
        }


def command_policy_enabled() -> bool:
    """命令级策略是否**强制**。

    默认 **False** —— 本模块默认只分类、不阻断，避免静默改变既有部署的
    放行结果（那属于安全模型变更）。需显式设
    ``ROVEAGENT_COMMAND_POLICY=enforce`` 才启用强制。
    """
    return os.environ.get("ROVEAGENT_COMMAND_POLICY", "").strip().lower() in (
        "enforce", "1", "true", "yes", "on",
    )


#: 复合命令分隔符（顺序：先长后短，避免 && 被 & 拆坏）
_SPLIT_RE = re.compile(r"(?:\r?\n|;|&&|\|\||\||&)")


def _split_segments(command: str) -> List[str]:
    return [part.strip() for part in _SPLIT_RE.split(command or "") if part and part.strip()]


def _match_any(segment: str, patterns: Sequence[re.Pattern[str]]) -> Optional[re.Pattern[str]]:
    for pattern in patterns:
        if pattern.search(segment):
            return pattern
    return None


def _classify_segment(segment: str) -> tuple[str, Optional[str], str]:
    """给单段命令定级。

    顺序固定：read → destructive → deploy → mutate → unknown(fail-closed)。
    destructive 先于 mutate 判定，因为 ``docker rm`` 在 mutate 规则里，
    但语义更接近破坏性 —— 破坏性优先以更保守的一档处理。
    """
    # 1. 只读优先（最具体）
    hit = _match_any(segment, _READ_PATTERNS)
    if hit is not None:
        return CommandClass.READ, hit.pattern, "matches read-only allowlist"

    # 2. 破坏性
    hit = _match_any(segment, _DESTRUCTIVE_PATTERNS)
    if hit is not None:
        return CommandClass.DESTRUCTIVE, hit.pattern, "matches destructive pattern"

    # 3. 部署
    hit = _match_any(segment, _DEPLOY_PATTERNS)
    if hit is not None:
        return CommandClass.DEPLOY, hit.pattern, "matches deploy pattern"

    # 4. 可逆变更
    hit = _match_any(segment, _MUTATE_PATTERNS)
    if hit is not None:
        return CommandClass.MUTATE, hit.pattern, "matches mutate pattern"

    # 5. 未知 → fail-closed，按 mutate（需审批）处理
    return CommandClass.MUTATE, None, "unrecognized command; treated as mutate (fail-closed)"


def classify_command(command: str) -> CommandVerdict:
    """判定一条终端命令的档位。

    复合命令（``a && b`` / ``a; b`` / ``a | b``）按**最严**的一段定级 ——
    否则 ``tasklist && taskkill /F /IM x`` 会被前段的只读属性蒙混过关。

    纯函数、确定性、无副作用。
    """
    raw = command or ""
    segments = _split_segments(raw)
    if not segments:
        return CommandVerdict(
            command=raw, classification=CommandClass.MUTATE,
            read_only=False, reason="empty command; treated as mutate (fail-closed)",
        )

    # 严重度序：read < mutate < deploy < destructive
    rank = {
        CommandClass.READ: 0,
        CommandClass.MUTATE: 1,
        CommandClass.DEPLOY: 2,
        CommandClass.DESTRUCTIVE: 3,
    }
    worst = CommandClass.READ
    worst_rule: Optional[str] = None
    worst_reason = ""
    detail: List[Dict[str, Any]] = []

    for segment in segments:
        classification, rule, reason = _classify_segment(segment)
        detail.append({
            "segment": segment,
            "classification": classification,
            "matched_rule": rule,
        })
        if rank[classification] > rank[worst]:
            worst = classification
            worst_rule = rule
            worst_reason = reason

    if worst == CommandClass.READ and len(segments) > 1:
        worst_reason = f"all {len(segments)} segments are read-only"
    elif not worst_reason:
        worst_reason = "matches read-only allowlist"

    return CommandVerdict(
        command=raw,
        classification=worst,
        matched_rule=worst_rule,
        read_only=(worst == CommandClass.READ),
        reason=worst_reason,
        segments=detail,
    )


def classify_commands(commands: Sequence[str]) -> List[CommandVerdict]:
    return [classify_command(c) for c in commands]


def extract_command(args: Any) -> Optional[str]:
    """从工具参数里取命令字符串。

    兼容 ``{"command": "..."}`` 与 ``{"command": ["a", "b"]}`` 两种形态
    （``terminal`` 工具历史上两种都出现过）。
    """
    if not isinstance(args, dict):
        return None
    raw = args.get("command")
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (list, tuple)):
        return " && ".join(str(part) for part in raw if str(part).strip())
    # 少数调用把命令放在 args["cmd"]
    other = args.get("cmd")
    if isinstance(other, str):
        return other
    return None


def shlex_available() -> bool:
    """``shlex`` 可用性探测（供未来做更精细的 token 级规则）。"""
    try:
        shlex.split("echo ok")
        return True
    except Exception:  # noqa: BLE001
        return False
