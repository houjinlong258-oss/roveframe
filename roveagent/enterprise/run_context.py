"""Request-safe immutable context for one RoveAgent execution."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

from ..tools.framework import ToolContext


_CURRENT_TOOL_CONTEXT: ContextVar[Optional[ToolContext]] = ContextVar(
    "roveagent_tool_context",
    default=None,
)


@contextmanager
def bind_tool_context(context: ToolContext) -> Iterator[ToolContext]:
    """Bind one immutable context to the current async/thread execution flow."""

    token = _CURRENT_TOOL_CONTEXT.set(context)
    try:
        yield context
    finally:
        _CURRENT_TOOL_CONTEXT.reset(token)


def current_tool_context() -> Optional[ToolContext]:
    """Return the current run context without consulting process-global state."""

    return _CURRENT_TOOL_CONTEXT.get()
