"""Connector 基类：统一 POS/电商接入协议。

真实接入路径：OAuth 换取 access_token → REST 拉取/Webhook 推送 →
标准化后经 RoveFrame Business Adapter 写入唯一业务数据库。sandbox=True 时使用内置沙箱数据，
便于无凭据环境下的全链路测试。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

from ..business.data_layer import BusinessDataLayer


class ConnectorError(RuntimeError):
    pass


@dataclass
class SyncResult:
    provider: str
    orders: int = 0
    products: int = 0
    customers: int = 0
    inventory: int = 0
    errors: list[str] = field(default_factory=list)
    synced_at: float = field(default_factory=time.time)


class Connector:
    provider = "base"
    api_base = ""
    supports_oauth = True
    supports_webhook = True

    def __init__(self, data_layer: BusinessDataLayer,
                 access_token: Optional[str] = None,
                 webhook_secret: Optional[str] = None,
                 sandbox: bool = False,
                 extra: Optional[dict] = None):
        self.dl = data_layer
        self.access_token = access_token
        self.webhook_secret = webhook_secret
        self.sandbox = sandbox
        self.extra = extra or {}

    # ---------- HTTP ----------

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        if not self.access_token:
            raise ConnectorError(f"{self.provider}: access_token required (complete OAuth first)")
        url = f"{self.api_base}{path}"
        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", f"Bearer {self.access_token}")
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urllib.request.urlopen(req, data=data, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            raise ConnectorError(f"{self.provider} API {method} {path} failed: {e}") from e

    def oauth_authorize_url(self, redirect_uri: str, state: str) -> str:
        raise NotImplementedError

    def oauth_exchange(self, code: str, redirect_uri: str) -> dict:
        """OAuth code → token。子类实现真实 token 交换。"""
        raise NotImplementedError

    # ---------- Webhook ----------

    def verify_webhook(self, raw_body: bytes, signature: str) -> bool:
        """HMAC-SHA256 签名校验（各 provider 头名不同，由子类传入）。"""
        if not self.webhook_secret:
            raise ConnectorError(f"{self.provider}: webhook_secret not configured")
        digest = hmac.new(self.webhook_secret.encode(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(digest, signature)

    def handle_webhook(self, event: dict) -> SyncResult:
        """接收 webhook 事件并写库。子类实现事件→标准记录映射。"""
        raise NotImplementedError

    # ---------- 定时同步 ----------

    def sync_orders(self, since: float = 0) -> SyncResult:
        raise NotImplementedError

    def sync_products(self) -> SyncResult:
        raise NotImplementedError

    def sync_customers(self) -> SyncResult:
        raise NotImplementedError

    def sync_inventory(self) -> SyncResult:
        raise NotImplementedError

    def sync_all(self, since: float = 0) -> SyncResult:
        total = SyncResult(provider=self.provider)
        for fn in (self.sync_orders, self.sync_products, self.sync_customers, self.sync_inventory):
            try:
                r = fn(since) if fn is self.sync_orders else fn()  # type: ignore[misc]
                total.orders += r.orders
                total.products += r.products
                total.customers += r.customers
                total.inventory += r.inventory
                total.errors.extend(r.errors)
            except ConnectorError as e:
                total.errors.append(str(e))
        return total
