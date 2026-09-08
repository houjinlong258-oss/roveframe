"""POS 生态连接层：统一 Connector 协议 + Square / Toast / Clover。

第一阶段：Square / Toast / Clover；第二阶段：Lightspeed / Shopify POS / ERPNext。
所有渠道支持 OAuth、Webhook、订单/商品/客户/库存同步，数据统一写入 RoveFrame Business Database。
"""

from .base import Connector, ConnectorError, SyncResult  # noqa: F401
from .square import SquareConnector  # noqa: F401
from .toast import ToastConnector  # noqa: F401
from .clover import CloverConnector  # noqa: F401

CONNECTORS = {
    "square": SquareConnector,
    "toast": ToastConnector,
    "clover": CloverConnector,
}
