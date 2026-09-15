"""Sandbox-side plugin runner — the code that executes INSIDE the sandbox process.

Why this file is deliberately standalone
----------------------------------------

This module is launched as a separate OS process by
``api.plugin_isolation.PluginSandboxProcess``. It must import almost nothing
from the host: every host module it pulled in would be host code running in a
process that is supposed to be running untrusted code, and would widen the blast
radius it exists to contain.

The protocol is JSON-RPC 2.0 over stdio, one compact JSON object per line —
the same wire shape MCP uses, chosen so this boundary can later be spoken to by
an MCP client without redesigning it:

  host -> runner   {"jsonrpc":"2.0","id":N,"method":"...","params":{...}}
  runner -> host   {"jsonrpc":"2.0","id":N,"result":{...}}
                   {"jsonrpc":"2.0","id":N,"error":{"code":C,"message":"..."}}

Methods
-------

  initialize     load the plugin module and call its optional ``on_load``
  tools/list     the tool names the plugin exposes
  tools/call     invoke one tool
  ping           liveness
  shutdown       call the plugin's optional ``on_unload`` and exit

Fault isolation contract
------------------------

Nothing a plugin does may terminate this process abnormally in a way that the
host cannot attribute:

  * An import failure returns a JSON-RPC error; the process exits 0.
  * An exception inside a tool returns a JSON-RPC error for THAT call; the
    process stays alive, so one bad tool does not take down the plugin.
  * A plugin that writes to stdout would corrupt the stream. stdout is
    therefore redirected to stderr before the plugin is imported, and the
    protocol owns the real stdout exclusively. A plugin printing to stdout
    would otherwise inject forged JSON-RPC frames — that is a real attack, not
    a tidiness concern.

Everything is reported on the protocol channel; stderr carries diagnostics only.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import traceback
from typing import Any, Callable, Dict, Optional

PROTOCOL_VERSION = "1"
MAX_LINE_BYTES = 8 * 1024 * 1024

# JSON-RPC error codes. -32000..-32099 is the implementation-defined server
# range, used here so a plugin error is distinguishable from a transport error.
E_PARSE = -32700
E_INVALID_REQUEST = -32600
E_METHOD_NOT_FOUND = -32601
E_INVALID_PARAMS = -32602
E_PLUGIN_IMPORT = -32001
E_PLUGIN_LOAD_HOOK = -32002
E_PLUGIN_TOOL = -32003
E_BAD_PROTOCOL = -32000


class _Protocol:
    """Owns the real stdout. Plugins never see it."""

    def __init__(self, out: io.TextIOBase) -> None:
        self._out = out

    def send(self, payload: Dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False, default=str)
        if len(line.encode("utf-8")) > MAX_LINE_BYTES:
            line = json.dumps({
                "jsonrpc": "2.0", "id": payload.get("id"),
                "error": {"code": E_PLUGIN_TOOL,
                          "message": "response exceeded the protocol size limit"},
            }, ensure_ascii=False)
        self._out.write(line + "\n")
        self._out.flush()

    def result(self, request_id: Any, value: Any) -> None:
        self.send({"jsonrpc": "2.0", "id": request_id, "result": value})

    def error(self, request_id: Any, code: int, message: str,
              data: Optional[Dict[str, Any]] = None) -> None:
        err: Dict[str, Any] = {"code": code, "message": message}
        if data:
            err["data"] = data
        self.send({"jsonrpc": "2.0", "id": request_id, "error": err})


class _PluginHost:
    """Loads one plugin module and dispatches calls into it.

    Holds no host services. A plugin gets its own module namespace and can
    reach nothing else through this class.
    """

    def __init__(self, plugin_path: str, module_name: str, tool_names: list[str]) -> None:
        self.plugin_path = plugin_path
        self.module_name = module_name
        self.declared_tools = list(tool_names)
        self.module: Any = None
        self._handlers: Dict[str, Callable[..., Any]] = {}
        self.import_error: str = ""

    def load(self) -> None:
        """Import the plugin module from an explicit file path.

        Uses ``spec_from_file_location`` rather than putting the plugin's
        directory on ``sys.path``: a plugin must not be able to shadow a host
        module by shipping a file with the same name.
        """
        target = os.path.join(self.plugin_path, "__init__.py")
        if not os.path.isfile(target):
            target = os.path.join(self.plugin_path, "plugin.py")
        if not os.path.isfile(target):
            self.import_error = (
                "no __init__.py or plugin.py found in %s" % self.plugin_path)
            return
        spec = importlib.util.spec_from_file_location(
            "roveagent_sandboxed_plugin", target,
            submodule_search_locations=[self.plugin_path],
        )
        if spec is None or spec.loader is None:
            self.import_error = "cannot build an import spec for %s" % target
            return
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.module = module
        self._collect_handlers()

    def _collect_handlers(self) -> None:
        """Discover callables the plugin exposes.

        Two conventions are accepted because plugins in this tree use both:
        an explicit ``TOOLS`` mapping, and module-level callables whose name
        matches a declared tool.
        """
        mapping = getattr(self.module, "TOOLS", None)
        if isinstance(mapping, dict):
            for name, handler in mapping.items():
                if callable(handler):
                    self._handlers[str(name)] = handler
        for name in self.declared_tools:
            handler = getattr(self.module, name, None)
            if callable(handler):
                self._handlers.setdefault(name, handler)

    def tool_names(self) -> list[str]:
        if self._handlers:
            return sorted(self._handlers)
        return sorted(self.declared_tools)

    def call(self, name: str, arguments: Dict[str, Any]) -> Any:
        handler = self._handlers.get(name)
        if handler is None:
            raise _NoSuchTool(name)
        return handler(**arguments)


class _NoSuchTool(LookupError):
    pass


def serve(stdin: io.TextIOBase, stdout: io.TextIOBase) -> int:
    """Read requests until EOF or ``shutdown``. Returns the process exit code."""
    protocol = _Protocol(stdout)
    host: Optional[_PluginHost] = None

    for raw in stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            protocol.error(None, E_PARSE, "invalid JSON: %s" % exc)
            continue
        if not isinstance(request, dict):
            protocol.error(None, E_INVALID_REQUEST, "request must be a JSON object")
            continue

        method = request.get("method")
        request_id = request.get("id")
        params = request.get("params")
        params = params if isinstance(params, dict) else {}

        if not isinstance(method, str):
            protocol.error(request_id, E_INVALID_REQUEST, "method must be a string")
            continue

        if method == "ping":
            protocol.result(request_id, {"pong": True, "pid": os.getpid()})
            continue

        if method == "initialize":
            if host is not None:
                protocol.result(request_id, {"already_initialized": True})
                continue
            plugin_path = str(params.get("plugin_path") or "")
            module_name = str(params.get("module_name") or "plugin")
            tools = params.get("tools")
            tools = [str(t) for t in tools] if isinstance(tools, list) else []
            if not plugin_path or not os.path.isdir(plugin_path):
                protocol.error(request_id, E_INVALID_PARAMS,
                               "plugin_path must be an existing directory")
                continue
            candidate = _PluginHost(plugin_path, module_name, tools)
            try:
                candidate.load()
            except Exception as exc:  # noqa: BLE001 — any import failure is the plugin's
                protocol.error(request_id, E_PLUGIN_IMPORT,
                               "%s: %s" % (type(exc).__name__, exc),
                               {"traceback": traceback.format_exc()[-2000:]})
                continue
            if candidate.import_error:
                protocol.error(request_id, E_PLUGIN_IMPORT, candidate.import_error)
                continue
            on_load = getattr(candidate.module, "on_load", None)
            if callable(on_load):
                try:
                    on_load()
                except Exception as exc:  # noqa: BLE001
                    protocol.error(request_id, E_PLUGIN_LOAD_HOOK,
                                   "on_load failed: %s: %s" % (type(exc).__name__, exc),
                                   {"traceback": traceback.format_exc()[-2000:]})
                    continue
            host = candidate
            protocol.result(request_id, {
                "protocol_version": PROTOCOL_VERSION,
                "pid": os.getpid(),
                "tools": host.tool_names(),
            })
            continue

        if host is None:
            protocol.error(request_id, E_BAD_PROTOCOL,
                           "initialize must be the first request")
            continue

        if method == "tools/list":
            protocol.result(request_id, {"tools": host.tool_names()})
            continue

        if method == "tools/call":
            name = str(params.get("name") or "")
            arguments = params.get("arguments")
            arguments = arguments if isinstance(arguments, dict) else {}
            try:
                value = host.call(name, arguments)
            except _NoSuchTool as exc:
                protocol.error(request_id, E_METHOD_NOT_FOUND, str(exc))
                continue
            except TypeError as exc:
                # A signature mismatch is a plugin bug, not a host failure.
                protocol.error(request_id, E_INVALID_PARAMS,
                               "bad arguments for %r: %s" % (name, exc))
                continue
            except Exception as exc:  # noqa: BLE001 — a plugin tool may raise anything
                protocol.error(request_id, E_PLUGIN_TOOL,
                               "%s: %s" % (type(exc).__name__, exc),
                               {"traceback": traceback.format_exc()[-2000:]})
                continue
            protocol.result(request_id, {"content": value})
            continue

        if method == "shutdown":
            on_unload = getattr(host.module, "on_unload", None) if host else None
            if callable(on_unload):
                try:
                    on_unload()
                except Exception:  # noqa: BLE001 — shutdown must not fail
                    pass
            protocol.result(request_id, {"bye": True})
            return 0

        protocol.error(request_id, E_METHOD_NOT_FOUND,
                       "unknown method %r" % method)

    return 0


def main(argv: Optional[list[str]] = None) -> int:
    """Entry point. Redirects stdout BEFORE any plugin code can run."""
    real_stdout = sys.stdout
    # From here on, anything the plugin prints to stdout goes to stderr instead.
    # Without this a plugin could emit forged JSON-RPC frames on the protocol
    # channel and impersonate the host's own replies.
    sys.stdout = sys.stderr
    try:
        return serve(sys.stdin, real_stdout)
    except KeyboardInterrupt:
        return 130
    except Exception:  # noqa: BLE001 — never die silently on the protocol channel
        try:
            traceback.print_exc(file=sys.stderr)
        finally:
            return 70


if __name__ == "__main__":
    raise SystemExit(main())
