"""Square POS Connector（第一阶段）。

真实 API：Square v2 —— Orders / Catalog / Customers / Inventory。
sandbox=True 时使用 Square Sandbox 语义的内置样本数据。
"""

from __future__ import annotations

from .base import Connector, SyncResult

SANDBOX_ORDERS = [
    {"id": "sq_ord_1001", "total_money": {"amount": 4260, "currency": "USD"},
     "state": "COMPLETED", "created_at": 1757000000.0,
     "line_items": [{"name": "Mapo Tofu", "quantity": "2"}, {"name": "Dan Dan Noodles", "quantity": "1"}]},
    {"id": "sq_ord_1002", "total_money": {"amount": 6890, "currency": "USD"},
     "state": "COMPLETED", "created_at": 1757003600.0,
     "line_items": [{"name": "Hot Pot Combo", "quantity": "1"}, {"name": "Kung Pao Chicken", "quantity": "1"}]},
]
SANDBOX_ITEMS = [
    {"id": "sq_item_1", "item_data": {"name": "Mapo Tofu", "category": "Sichuan Classics",
     "variations": [{"item_variation_data": {"price_money": {"amount": 1280}}}]}},
    {"id": "sq_item_2", "item_data": {"name": "Hot Pot Combo", "category": "Hot Pot",
     "variations": [{"item_variation_data": {"price_money": {"amount": 4800}}}]}},
]
SANDBOX_CUSTOMERS = [
    {"id": "sq_cus_1", "given_name": "Alice Chen", "email_address": "alice@example.com"},
    {"id": "sq_cus_2", "given_name": "Bob Smith", "email_address": "bob@example.com"},
]
SANDBOX_INVENTORY = [
    {"catalog_object_id": "sq_item_1", "quantity": "42"},
    {"catalog_object_id": "sq_item_2", "quantity": "3"},  # 低库存 → 触发异常检测
]


class SquareConnector(Connector):
    provider = "square"
    api_base = "https://connect.squareup.com/v2"

    def oauth_authorize_url(self, redirect_uri: str, state: str) -> str:
        client_id = self.extra.get("client_id", "")
        return (f"https://connect.squareup.com/oauth2/authorize"
                f"?client_id={client_id}&scope=ORDERS_READ+CUSTOMERS_READ+ITEMS_READ+INVENTORY_READ"
                f"&session=false&state={state}&redirect_uri={redirect_uri}")

    def oauth_exchange(self, code: str, redirect_uri: str) -> dict:
        url = "https://connect.squareup.com/oauth2/token"
        body = {
            "client_id": self.extra.get("client_id", ""),
            "client_secret": self.extra.get("client_secret", ""),
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        }
        req_body = __import__("json").dumps(body).encode()
        import urllib.request
        req = urllib.request.Request(url, data=req_body, method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as resp:
            import json
            return json.loads(resp.read().decode())

    def handle_webhook(self, event: dict) -> SyncResult:
        r = SyncResult(provider=self.provider)
        etype = event.get("type", "")
        data = event.get("data", {}).get("object", {})
        if etype == "order.created" or etype == "order.updated":
            order = data.get("order", data)
            self._write_order(order)
            r.orders = 1
        elif etype == "inventory.count.updated":
            counts = data.get("inventory_counts", [])
            for c in counts:
                self.dl.set_inventory(c.get("catalog_object_id", "unknown"),
                                      float(c.get("quantity", 0)))
                r.inventory += 1
        return r

    def _write_order(self, order: dict) -> str:
        cents = order.get("total_money", {}).get("amount", 0)
        items = [{"name": li.get("name", "?"), "qty": int(li.get("quantity", "1"))}
                 for li in order.get("line_items", [])]
        return self.dl.upsert_order(
            source="square", external_id=order["id"], total=cents / 100.0,
            items=items, status=str(order.get("state", "COMPLETED")).lower(),
            created_at=float(order.get("created_at", 0)) or None,
        )

    def sync_orders(self, since: float = 0) -> SyncResult:
        r = SyncResult(provider=self.provider)
        if self.sandbox:
            orders = SANDBOX_ORDERS
        else:
            resp = self._request("POST", "/orders/search",
                                 {"query": {"filter": {"date_time_filter":
                                  {"created_at": {"start_at": int(since)}}}}})
            orders = resp.get("orders", [])
        for o in orders:
            self._write_order(o)
            r.orders += 1
        return r

    def sync_products(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        if self.sandbox:
            objects = SANDBOX_ITEMS
        else:
            resp = self._request("GET", "/catalog/list?types=ITEM")
            objects = resp.get("objects", [])
        for obj in objects:
            data = obj.get("item_data", {})
            variations = data.get("variations", [{}])
            cents = variations[0].get("item_variation_data", {}).get("price_money", {}).get("amount", 0)
            self.dl.upsert_product("square", obj["id"], data.get("name", "?"),
                                   cents / 100.0, data.get("category", ""))
            r.products += 1
        return r

    def sync_customers(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        customers = SANDBOX_CUSTOMERS if self.sandbox else self._request("GET", "/customers").get("customers", [])
        for c in customers:
            self.dl.upsert_customer("square", c["id"], c.get("given_name", ""),
                                    c.get("email_address", ""))
            r.customers += 1
        return r

    def sync_inventory(self) -> SyncResult:
        r = SyncResult(provider=self.provider)
        if self.sandbox:
            counts = SANDBOX_INVENTORY
        else:
            resp = self._request("POST", "/inventory/batch-retrieve-counts", {})
            counts = resp.get("counts", [])
        for c in counts:
            self.dl.set_inventory(c.get("catalog_object_id", "unknown"),
                                  float(c.get("quantity", 0)))
            r.inventory += 1
        return r
