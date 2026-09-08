"""生产自愈闭环：Error Detection → AI Diagnosis → Generate Fix → Sandbox Test →
Human Approval → Deploy → Monitor。所有修改 Git 记录、Diff 审核、可 Rollback。"""

from .healing import SelfHealingEngine, HealingCase  # noqa: F401
