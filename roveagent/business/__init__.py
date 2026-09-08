"""RoveFrame Business Adapter：RoveAgent 获取真实经营数据的唯一入口。"""

from .data_layer import BusinessDataLayer  # noqa: F401
from .metrics import DailyMetrics, compute_daily_metrics  # noqa: F401
from .anomalies import Anomaly, detect_anomalies  # noqa: F401
