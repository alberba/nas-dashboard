"""Normalise the pinned Telegram HTML chat export into flat rows.

The export lives outside the repository and is read exactly once per run: the
bytes are hashed against the pin before anything is parsed. Parsing never opens
a socket, never executes exported markup and ignores every ``div`` that is not a
message, a sender, a date separator or a message body.
"""
from __future__ import annotations

EXPECTED_SHA256 = "fe32cd3a63464261527d74ee77f53696b1b5837f58206230e15fa93291fdbe74"
EXPECTED_BYTES = 76936
MAX_EXPORT_BYTES = 16 * 1024 * 1024
MAX_TEXT_CHARS = 4000

MESES = {
    "enero": 1,
    "febrero": 2,
    "marzo": 3,
    "abril": 4,
    "mayo": 5,
    "junio": 6,
    "julio": 7,
    "agosto": 8,
    "septiembre": 9,
    "octubre": 10,
    "noviembre": 11,
    "diciembre": 12,
}

MESSAGE_CLASSES = ("message default clearfix", "message default clearfix joined")
SERVICE_CLASS = "message service"


class DatasetHashError(ValueError):
    """The export bytes do not match the pinned digest."""


class TelegramExport:
    """Parser shape for the export; behaviour lands in the green step."""

    def __init__(self, *args, **kwargs):
        raise NotImplementedError


def parse_title(title):
    raise NotImplementedError


def normalize_text(value):
    raise NotImplementedError


def read_pinned_bytes(path):
    raise NotImplementedError


def parse_export_document(path, expected_sha256=EXPECTED_SHA256):
    raise NotImplementedError


def parse_export(path, expected_sha256=EXPECTED_SHA256):
    raise NotImplementedError


def write_ndjson(rows, path):
    raise NotImplementedError
