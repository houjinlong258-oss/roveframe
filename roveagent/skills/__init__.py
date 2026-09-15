"""行业插件体系：Industry Pack（Skills + Agents + Connectors + Templates + Knowledge Base）。

Phase 11 / Task 4（方案 A）：本包是技能系统的**唯一公开入口**。
技能市场（``catalog`` / ``install`` / ``install_ex`` / ``evaluate_install``）
与安全流水线一并从这里导出，调用方不再需要知道 ``roveagent.skills_market``
的内部结构；``skills_market`` 作为被吸收的实现细节保留原位，其自身测试
（以绝对路径导入 ``roveagent.skills_market.*``）继续独立通过。
"""

from .packs import IndustryPack, load_pack, list_packs  # noqa: F401
from .marketplace import (  # noqa: F401
    SKILL_ENFORCE_ENV,
    MarketSkill,
    catalog,
    enforcement_enabled,
    evaluate_install,
    install,
    install_ex,
)
