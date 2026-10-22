"""The worker's logs: readable text (development) or one JSON line per event (containers/Kubernetes)."""
import json
import logging
import os
import sys
from datetime import datetime, timezone

_STANDARD = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    """One JSON line per event. Fields passed in `extra={...}` become keys of their own (e.g. job, stage)."""

    def format(self, record: logging.LogRecord) -> str:
        data = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        data.update({key: value for key, value in record.__dict__.items() if key not in _STANDARD})
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, ensure_ascii=False, default=str)


def setup_logging(fmt: str | None = None, level: str | None = None) -> None:
    """LOG_FORMAT=json|text (default: text) and LOG_LEVEL (default: INFO)."""
    fmt = (fmt or os.environ.get("LOG_FORMAT", "text")).lower()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter() if fmt == "json" else logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel((level or os.environ.get("LOG_LEVEL", "INFO")).upper())
