"""Phase 12 / R-01 —— 健康端点的公开/鉴权边界契约。

锁定三件事：

1. ``GET /api/health`` 无鉴权可用（容器 HEALTHCHECK 需要它）。
2. 它**不返回任何业务字段**（原实现返回 ``tenants`` 租户数）。
3. 它**不产生磁盘副作用**（原实现调 ``get_context()``，会
   ``mkdir`` 出整个数据根，并让首次探针承受全部初始化成本）。

详细信息改由 ``GET /api/health/detail`` 提供，且必须携带 ``X-RoveAgent-Key``。

不需要真实内核数据：用一个空的临时根即可。
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

TEST_KEY = "health-contract-test-key"


class HealthEndpointContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        os.environ["ROVEAGENT_API_KEY"] = TEST_KEY
        os.environ.setdefault("ROVEAGENT_OFFLINE", "1")
        cls._tmp = tempfile.TemporaryDirectory(prefix="health-contract-")
        cls._root = Path(cls._tmp.name)
        os.environ["ROVEAGENT_ROOT"] = str(cls._root)
        os.environ["ROVEAGENT_HOME"] = str(cls._root)

        from roveagent.api.app import create_app

        cls.app = create_app()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def _client(self):
        from starlette.testclient import TestClient

        return TestClient(self.app)

    def test_public_health_needs_no_auth(self) -> None:
        with self._client() as client:
            resp = client.get("/api/health")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body.get("status"), "ok")
        self.assertEqual(body.get("service"), "roveagent")

    def test_public_health_leaks_no_business_fields(self) -> None:
        """租户数等业务信息不得出现在无鉴权端点上。"""
        with self._client() as client:
            body = client.get("/api/health").json()
        self.assertNotIn("tenants", body, "公开健康端点不得返回租户数")
        allowed = {"status", "service", "ts"}
        self.assertTrue(
            set(body).issubset(allowed),
            f"公开健康端点出现未预期字段: {set(body) - allowed}",
        )

    def test_public_health_has_no_disk_side_effect(self) -> None:
        """公开探针不得创建数据根。

        这是原实现最隐蔽的问题：一个无鉴权端点会 ``mkdir -p`` 出整个状态树。
        用一个全新的、尚不存在的根来断言它探测后依然不存在。
        """
        fresh = self._root / "must-not-be-created"
        previous = os.environ.get("ROVEAGENT_ROOT")
        os.environ["ROVEAGENT_ROOT"] = str(fresh)
        try:
            # 重新构建 app，使其读取新的 ROOT（get_context 是惰性单例）
            import roveagent.api.app as app_module

            app_module._ctx = None
            from roveagent.api.app import create_app
            from starlette.testclient import TestClient

            with TestClient(create_app()) as client:
                resp = client.get("/api/health")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertFalse(
                fresh.exists(),
                "公开健康探针创建了数据根 —— 无鉴权端点不得有磁盘副作用",
            )
        finally:
            if previous is None:
                os.environ.pop("ROVEAGENT_ROOT", None)
            else:
                os.environ["ROVEAGENT_ROOT"] = previous
            import roveagent.api.app as app_module

            app_module._ctx = None

    def test_detail_health_requires_auth(self) -> None:
        with self._client() as client:
            unauth = client.get("/api/health/detail")
            authed = client.get("/api/health/detail", headers={"X-RoveAgent-Key": TEST_KEY})
        self.assertEqual(unauth.status_code, 401, "详细健康信息必须要求鉴权")
        self.assertEqual(authed.status_code, 200, authed.text)
        # 详细端点才是租户数该出现的地方
        self.assertIn("tenants", authed.json())


if __name__ == "__main__":
    unittest.main()
