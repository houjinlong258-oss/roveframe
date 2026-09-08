"""P0-12：任务存储乐观锁 + execute 意图登记诚实化测试。"""
from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

from roveagent.api.tasks import (
    ConcurrentTaskUpdateError,
    Task,
    TaskStep,
    TaskStore,
    new_task,
)


def _task(store: TaskStore, tenant: str = "t-1", business: str = "b-1") -> Task:
    task = new_task(tenant, business, "double execute", objective="run once")
    task.steps = [
        TaskStep(id="s1", title="分析", assignee="analyst", kind="analyze"),
        TaskStep(id="s2", title="执行", assignee="ops", kind="execute",
                 needs_approval=True),
    ]
    store.create(task)
    return task


class TaskStoreOptimisticLockTest(unittest.TestCase):
    def test_create_and_update_bump_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(Path(tmp))
            task = _task(store)
            self.assertEqual(task.version, 0)
            loaded = store.get("t-1", "b-1", task.id)
            self.assertIsNotNone(loaded)
            loaded.status = "running"
            updated = store.update(loaded)
            self.assertEqual(updated.version, 1)
            stored = store.get("t-1", "b-1", task.id)
            self.assertEqual(stored.version, 1)

    def test_stale_update_raises_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(Path(tmp))
            task = _task(store)
            base_a = store.get("t-1", "b-1", task.id)
            base_b = store.get("t-1", "b-1", task.id)
            base_a.status = "running"
            self.assertEqual(store.update(base_a).version, 1)
            base_b.status = "done"
            with self.assertRaises(ConcurrentTaskUpdateError):
                store.update(base_b)

    def test_concurrent_updates_only_one_wins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(Path(tmp))
            task = _task(store)
            base_a = store.get("t-1", "b-1", task.id)
            base_b = store.get("t-1", "b-1", task.id)
            barrier = threading.Barrier(2)
            outcomes: list[str] = []

            def worker(base: Task, label: str) -> None:
                barrier.wait()
                try:
                    base.status = label
                    store.update(base)
                    outcomes.append(f"{label}:ok")
                except ConcurrentTaskUpdateError:
                    outcomes.append(f"{label}:conflict")

            threads = [
                threading.Thread(target=worker, args=(base_a, "running")),
                threading.Thread(target=worker, args=(base_b, "done")),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(len(outcomes), 2, str(outcomes))
            conflicts = sum(1 for outcome in outcomes if outcome.endswith(":conflict"))
            self.assertEqual(conflicts, 1,
                             f"并发双 execute 必须恰有一次冲突: {outcomes}")
            final = store.get("t-1", "b-1", task.id)
            self.assertEqual(final.version, 1)

    def test_legacy_record_without_version_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(Path(tmp))
            task = _task(store)
            # 去掉 version 字段模拟旧数据
            raw = task.to_dict()
            del raw["version"]
            import json as _json
            store.dir.joinpath("scope-legacy.json").write_text(
                _json.dumps([raw], ensure_ascii=False), encoding="utf-8")
            legacy = store.get("t-1", "b-1", task.id)
            self.assertIsNotNone(legacy)
            self.assertEqual(legacy.version, 0)


class ExecuteHonestyContractTest(unittest.TestCase):
    def test_execute_registers_intent_not_fake_done(self) -> None:
        source = Path(__file__).resolve().parent.parent / "api" / "app.py"
        text = source.read_text(encoding="utf-8")
        self.assertIn("intent registered", text)
        self.assertIn("step_intent_registered", text)
        self.assertNotIn('result = f"executed by', text,
                         "不得再伪报 executed by")
        self.assertIn("ConcurrentTaskUpdateError", text)
        self.assertIn("task was modified concurrently", text)


if __name__ == "__main__":
    unittest.main()
