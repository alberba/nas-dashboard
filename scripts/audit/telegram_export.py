"""Normalise the pinned Telegram HTML chat export into flat rows.

The export lives outside the repository and is read exactly once per run: the
bytes are hashed against the pin before anything is parsed. Parsing never opens
a socket, never executes exported markup and ignores every ``div`` that is not a
message, a sender, a date separator or a message body.

A row carries ``id``, ``joined``, ``sender``, ``sent_at`` (ISO-8601 in the wall
clock of the export, no zone), ``time`` (``True`` when the title carries a clock,
``None`` when it does not), ``hour``, ``text`` and ``length``. A ``joined`` row
inherits the last sender seen; a row without a previous sender is an error, never
a guess.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

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

    def __init__(self, expected, obtained):
        self.expected = expected
        self.obtained = obtained
        super().__init__(
            f"sha256 del export distinto del pin: esperado {expected}, obtenido {obtained}"
        )


def parse_title(title):
    """Return ``(datetime, has_clock)`` for a ``.pull_right.date.details`` title."""
    if not isinstance(title, str) or not title.strip():
        raise ValueError("mensaje sin título de fecha")
    date_part, _, clock = title.partition(",")
    fields = date_part.split()
    if len(fields) != 3:
        raise ValueError("fecha del export con forma inesperada")
    day, month_name, year = fields
    month = MESES.get(month_name.lower())
    if month is None:
        raise ValueError("mes del export desconocido")
    clock = clock.strip()
    if not clock:
        return datetime(int(year), month, int(day)), False
    parts = clock.split(":")
    if len(parts) != 3:
        raise ValueError("hora del export con forma inesperada")
    hour, minute, second = (int(part) for part in parts)
    return datetime(int(year), month, int(day), hour, minute, second), True


def normalize_text(value):
    """Unescape once, then turn the literal backslash-n pair into a real break."""
    if not isinstance(value, str):
        return ""
    return html.unescape(value).replace("\\n", "\n").strip()


def read_pinned_bytes(path):
    """Resolve, size-check and read the export bytes once."""
    resolved = Path(path).resolve(strict=True)
    with resolved.open("rb") as handle:
        raw = handle.read(MAX_EXPORT_BYTES + 1)
    if len(raw) > MAX_EXPORT_BYTES:
        raise ValueError(f"el export supera el límite de {MAX_EXPORT_BYTES} bytes")
    return raw


class TelegramExport(HTMLParser):
    """Depth-tracked parser: only message, sender, date and body divs matter."""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.rows = []
        self.date_separators = 0
        self._row = None
        self._sender = None
        self._mode = None
        self._depth = 0
        self._buf = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        classes = attributes.get("class") or ""
        if tag == "br":
            if self._mode == "text":
                self._buf.append("\n")
            return
        if tag != "div":
            return
        if SERVICE_CLASS in classes:
            self._mode, self._depth, self._buf = "service", 1, []
            return
        if classes in MESSAGE_CLASSES and str(attributes.get("id") or "").startswith("message"):
            # A text-less message (media, sticker) has no ``text`` div to close it;
            # flush the previous row before opening the next one so it is never lost.
            if self._row is not None:
                self._close_row("")
            self._row = {
                "id": attributes.get("id"),
                "joined": classes.endswith(" joined"),
            }
            return
        if self._mode:
            self._depth += 1
            return
        if self._row is None:
            return
        tokens = classes.split()
        if "from_name" in tokens:
            self._mode, self._depth, self._buf = "from", 1, []
            return
        if "pull_right" in tokens and "date" in tokens and "details" in tokens:
            self._row["title"] = attributes.get("title")
            return
        if tokens == ["text"]:
            self._mode, self._depth, self._buf = "text", 1, []

    def handle_endtag(self, tag):
        if tag != "div" or not self._mode:
            return
        self._depth -= 1
        if self._depth:
            return
        value = "".join(self._buf)
        mode, self._mode, self._buf = self._mode, None, []
        if mode == "service":
            self.date_separators += 1
        elif mode == "from":
            self._sender = html.unescape(value).strip() or None
            if self._row is not None:
                self._row["_own_sender"] = self._sender
        elif mode == "text":
            self._close_row(value)

    def handle_data(self, data):
        if self._mode:
            self._buf.append(data)

    def handle_entityref(self, name):
        if self._mode:
            self._buf.append(f"&{name};")

    def handle_charref(self, name):
        if self._mode:
            self._buf.append(f"&#{name};")

    def close(self):
        super().close()
        if self._row is not None:
            self._close_row("")

    def _close_row(self, value):
        row, self._row = self._row, None
        if row is None:
            return
        moment, has_clock = parse_title(row.get("title"))
        sender = row.pop("_own_sender", None)
        if sender is None:
            if not row["joined"]:
                raise ValueError("mensaje no joined sin remitente")
            sender = self._sender
            if sender is None:
                raise ValueError("mensaje joined sin remitente previo")
        text = normalize_text(value)
        row.pop("title", None)
        row.update(
            {
                "sender": sender,
                "sent_at": (
                    moment.isoformat(timespec="seconds")
                    if has_clock
                    else moment.date().isoformat()
                ),
                "time": True if has_clock else None,
                "hour": moment.hour if has_clock else None,
                "text": text[:MAX_TEXT_CHARS],
                "length": len(text),
            }
        )
        self.rows.append(row)


def parse_export_document(path, expected_sha256=EXPECTED_SHA256):
    """Return ``(rows, stats)``; ``expected_sha256=None`` skips the digest check."""
    raw = read_pinned_bytes(path)
    obtained = hashlib.sha256(raw).hexdigest()
    if expected_sha256 and obtained != expected_sha256:
        raise DatasetHashError(expected_sha256, obtained)
    parser = TelegramExport()
    parser.feed(raw.decode("utf-8"))
    parser.close()
    stats = {
        "sha256": obtained,
        "bytes": len(raw),
        "date_separators": parser.date_separators,
    }
    return parser.rows, stats


def parse_export(path, expected_sha256=EXPECTED_SHA256):
    """Return one row per message, in export order."""
    rows, _stats = parse_export_document(path, expected_sha256)
    return rows


def write_ndjson(rows, path):
    """Write the normalised rows outside the repository, one JSON object per line.

    The rows carry every message body, so the intermediate is private to the
    operator: the directory is created 0700 and the file 0600, and a symlink at
    the target path is refused instead of followed.
    """
    target = Path(path)
    parent = target.parent
    created = not parent.exists()
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if created:
        os.chmod(parent, 0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(target, flags, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    return target
