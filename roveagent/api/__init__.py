"""RoveAgent Service Layer — FastAPI 生产 API。

``create_app()`` 构建应用；``tasks`` 为任务存储。fastapi 为可选依赖
（``pip install roveagent-core[web]``），未安装时本包仍可被 import。
"""
from .tasks import Task, TaskStep, TaskStore, new_task

__all__ = ["Task", "TaskStep", "TaskStore", "new_task", "create_app"]


def __getattr__(name: str):
    if name == "create_app":
        from .app import create_app
        return create_app
    raise AttributeError(name)
