"""Aggregate the Telegram noise audit without copying message bodies.

Reads the pinned export through :mod:`telegram_export`, keeps the normalised
rows in a temporary NDJSON file and publishes aggregate counts only. The output
JSON never carries message bodies and never carries sender names.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import date, datetime
from pathlib import Path

import telegram_export

PHASE_DIR = (
    Path(__file__).resolve().parents[2] / ".planning" / "phases" / "01-auditor-a-del-ruido"
)
DEFAULT_OUT_JSON = PHASE_DIR / "01-AUDIT.json"
DEFAULT_NDJSON = Path("/tmp/noise-audit/messages.ndjson")
SCHEMA_VERSION = 1
BOT_SENDERS = frozenset({"NAS Monitor"})


def sender_kind(sender):
    raise NotImplementedError


def build_dataset_summary(rows, source):
    raise NotImplementedError


def build_sender_split(rows):
    raise NotImplementedError


def aggregate(rows, source, alerts=None):
    raise NotImplementedError


def canonical_json(data):
    raise NotImplementedError


def main(argv=None):
    raise NotImplementedError


if __name__ == "__main__":
    raise SystemExit(main())
