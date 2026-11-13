"""Read-only releases, blockers and journal for Maintenance · Deployments.

Everything here reads media-stack state, its Git checkout and the host journal.
No function writes to the checkout, starts a unit or changes a container.
"""
from __future__ import annotations

import datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import threading
import time

import maintenance

try:
    import yaml
except ImportError:  # pragma: no cover - the agent image always installs it
    yaml = None

MAX_HISTORY = 20
MAX_RETAINED = 20
MAX_JOURNAL_LINES = 500
DEFAULT_JOURNAL_LINES = 100
MAX_STATUS_FILES = 200
MAX_TEXT = 2_000

RELEASE_TAG = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")
REVISION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$")
STATE_FOLDER = re.compile(r"^[a-f0-9]{32}$")
ENV_ASSIGNMENT = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SECRET_TEXT = re.compile(
    r"(?i)\b(token|password|secret|api[_-]?key|authorization)\b(\s*[:=]\s*)([^\s,;]+)"
)
BEARER = re.compile(r"(?i)(bearer\s+)([A-Za-z0-9._~+/=-]{8,})")
JOURNAL_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}\.(service|timer)$")

JOURNAL_UNIT_KINDS = ("follower", "security", "backup")
PRIORITY_LEVELS = {
    0: "error",
    1: "error",
    2: "error",
    3: "error",
    4: "warning",
    5: "info",
    6: "info",
    7: "debug",
}



class GitError(RuntimeError):
    """A bounded Git read could not be completed."""


def _iso(epoch):
    if epoch is None:
        return None
    try:
        return (
            datetime.datetime.fromtimestamp(float(epoch), datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def _iso_from_text(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _text(value, limit=MAX_TEXT):
    return value[:limit] if isinstance(value, str) else None


def _string_list(value, limit=50):
    if not isinstance(value, list):
        return []
    return [item for item in (_text(entry, 200) for entry in value[:limit]) if item]


def version(tag):
    return tuple(map(int, tag[1:].split(".")))


def parse_line_count(value):
    if isinstance(value, bool):
        raise ValueError("Número de líneas no válido")
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and re.fullmatch(r"\d{1,4}", value.strip()):
        number = int(value.strip())
    else:
        raise ValueError("Número de líneas no válido")
    if not 1 <= number <= MAX_JOURNAL_LINES:
        raise ValueError("Número de líneas no válido")
    return number


def read_env(path):
    """Return the assignments of a Compose .env file without exposing values."""
    values = {}
    try:
        lines = Path(path).read_text(errors="replace").splitlines()
    except OSError:
        return values
    for line in lines:
        match = ENV_ASSIGNMENT.match(line)
        if not match:
            continue
        name, value = match.group(1), match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[name] = value
    return values


def _file_hash(path):
    digest = sha256()
    digest.update(Path(path).read_bytes())
    return digest.hexdigest()


def configuration_key(env_path, pins_path):
    """The follower's retry key: .env plus every absolute COMPOSE_FILE entry."""
    try:
        digest = sha256(Path(env_path).read_bytes())
    except OSError:
        return None
    pins = Path(pins_path).resolve()
    for name in read_env(env_path).get("COMPOSE_FILE", "").split(":"):
        path = Path(name)
        try:
            if (
                path.is_absolute()
                and path.is_file()
                and path.resolve() != pins
            ):
                digest.update(_file_hash(path).encode())
        except OSError:
            continue
    return digest.hexdigest()


def manual_steps(notes):
    """Bullets under ``## Manual steps``; placeholder None entries are dropped."""
    if not isinstance(notes, str):
        return []
    inside = False
    steps = []
    for line in notes.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            inside = stripped[3:].strip().lower() == "manual steps"
            continue
        if not inside or not stripped.startswith("- "):
            continue
        step = stripped[2:].strip()
        if not step or re.match(r"(?i)^none\b", step):
            continue
        steps.append(_text(step, 500))
    return [step for step in steps if step]


def breaking_changes(notes):
    return isinstance(notes, str) and re.search(
        r"(?im)^breaking changes:\s*yes\s*$", notes
    ) is not None


def unit_kind(name):
    if "merged-updates" in name:
        return "follower"
    if "security-updates" in name:
        return "security"
    if "backup" in name:
        return "backup"
    return "automation"


def journal_units(names):
    """Only the follower, security and backup units may reach the journal."""
    result = []
    for name in names:
        if unit_kind(name) not in JOURNAL_UNIT_KINDS:
            continue
        for suffix in (".service", ".timer"):
            unit = name + suffix
            if unit not in result:
                result.append(unit)
    return result


def _journal_time(value):
    if not isinstance(value, str) or not value.isdigit():
        return None
    try:
        return _iso(int(value) / 1_000_000)
    except (OverflowError, ValueError):
        return None


def _journal_message(value):
    if isinstance(value, list):
        try:
            value = bytes(byte for byte in value if isinstance(byte, int)).decode(
                "utf-8", "replace"
            )
        except ValueError:
            return None
    if not isinstance(value, str):
        return None
    text = ANSI.sub("", value)
    text = "".join(
        character
        for character in text
        if character in ("\n", "\t") or ord(character) >= 32
    ).strip()
    if not text:
        return None
    text = BEARER.sub(r"\1[redactado]", text)
    text = SECRET_TEXT.sub(r"\1\2[redactado]", text)
    return _text(text, 2_000)


def clean_journal(entries, allowed):
    """Keep only allowed units and never return credentials from a log line."""
    result = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        unit = _text(entry.get("unit"), 200)
        if unit not in allowed:
            continue
        message = _journal_message(entry.get("message"))
        at = _iso_from_text(entry.get("at"))
        if not message or not at:
            continue
        priority = entry.get("priority")
        try:
            priority = int(priority)
        except (TypeError, ValueError):
            priority = 6
        result.append(
            {
                "at": at,
                "unit": unit,
                "priority": priority,
                "level": PRIORITY_LEVELS.get(priority, "info"),
                "message": message,
            }
        )
    result.sort(key=lambda item: item["at"])
    return result


def parse_journal(raw, allowed):
    entries = []
    for line in raw.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        entries.append(
            {
                "at": _journal_time(record.get("__REALTIME_TIMESTAMP")),
                "unit": _text(
                    record.get("_SYSTEMD_UNIT")
                    or record.get("_SYSTEMD_USER_UNIT"),
                    200,
                ),
                "priority": record.get("PRIORITY"),
                "message": record.get("MESSAGE"),
            }
        )
    return clean_journal(entries, allowed)


class GitReader:
    """Runs a closed list of read-only Git commands without a shell."""

    def __init__(self, checkout, timeout=10):
        self.checkout = Path(checkout)
        self.timeout = timeout

    def available(self):
        return self.checkout.is_dir() and (self.checkout / ".git").exists()

    def run(self, *args):
        if not self.available():
            raise GitError("El checkout no está disponible")
        for argument in args:
            if not isinstance(argument, str) or "\x00" in argument:
                raise GitError("Argumento de Git no válido")
        environment = {
            "PATH": os.getenv("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": "/tmp",
            "LC_ALL": "C",
            "LANG": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_OPTIONAL_LOCKS": "0",
        }
        command = [
            "git",
            "--no-optional-locks",
            "-c",
            "safe.directory=" + str(self.checkout),
            "-c",
            "core.hooksPath=" + os.devnull,
            *args,
        ]
        try:
            result = subprocess.run(
                command,
                cwd=self.checkout,
                env=environment,
                text=True,
                capture_output=True,
                timeout=self.timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise GitError("No se pudo leer el checkout") from error
        if result.returncode:
            raise GitError("La lectura de Git no se completó")
        return result.stdout

    def _revision(self, value):
        if not isinstance(value, str) or not REVISION.fullmatch(value):
            raise GitError("Revisión de Git no válida")
        if ".." in value:
            raise GitError("Revisión de Git no válida")
        return value

    def tags(self):
        tags = []
        for line in self.run("tag", "--list").splitlines():
            tag = line.strip()
            if RELEASE_TAG.fullmatch(tag) and tag not in tags:
                tags.append(tag)
        return sorted(tags, key=version)

    def status(self):
        raw = self.run(
            "status", "--porcelain=v1", "-z", "--untracked-files=all"
        )
        fields = raw.split("\x00")
        files = []
        index = 0
        while index < len(fields):
            entry = fields[index]
            index += 1
            if len(entry) < 4:
                continue
            code, path = entry[:2], entry[3:]
            source = None
            if code[0] in ("R", "C") and index < len(fields):
                # -z puts the destination first and the source second.
                source = _text(fields[index], 500)
                index += 1
            files.append(
                {
                    "status": code.strip(),
                    "path": _text(path, 500),
                    "from": source,
                }
            )
        return files

    def text_at(self, revision, path):
        revision = self._revision(revision)
        if not isinstance(path, str) or path.startswith("/") or ".." in path.split("/"):
            raise GitError("Ruta de Git no válida")
        try:
            return self.run("show", revision + ":" + path)
        except GitError:
            return None

    def json_at(self, revision, path):
        raw = self.text_at(revision, path)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def has_ref(self, revision):
        try:
            self.run("rev-parse", "--verify", self._revision(revision))
            return True
        except GitError:
            return False

    def is_ancestor(self, ancestor, descendant):
        try:
            self.run(
                "merge-base",
                "--is-ancestor",
                self._revision(ancestor),
                self._revision(descendant),
            )
            return True
        except GitError:
            return False

    def commit(self, revision):
        return self.run("rev-parse", "--verify", self._revision(revision) + "^{commit}").strip()

    def commit_date(self, revision):
        return _iso_from_text(
            self.run("log", "-1", "--format=%cI", self._revision(revision)).strip()
        )

    def changed_files(self, base, target):
        raw = self.run(
            "diff",
            "--name-only",
            "-z",
            self._revision(base),
            self._revision(target),
        )
        return [path for path in raw.split("\x00") if path]

    def compose_files(self, revision, role):
        """The Compose files this host actually enables, following ``include``."""
        revision = self._revision(revision)
        project = "apps-server" if role == "apps-server" else ""
        root = posixpath.join(project, "compose.yaml")
        configured = read_env(self.checkout / _env_path(role)).get("COMPOSE_FILE", "")
        selected = [
            name
            for name in configured.split(":")
            if name
            and not Path(name).is_absolute()
            and not posixpath.normpath(name).startswith("../")
        ] or [root]
        files = []
        pending = list(selected)
        seen = set()
        while pending and len(seen) < 100:
            name = posixpath.normpath(pending.pop(0))
            if name in seen:
                continue
            seen.add(name)
            raw = self.text_at(revision, name)
            if raw is None:
                continue
            files.append(name)
            document = None
            if yaml:
                try:
                    document = yaml.load(raw, Loader=_ComposeLoader)
                except yaml.YAMLError:
                    document = None
            include = document.get("include") if isinstance(document, dict) else None
            for item in include if isinstance(include, list) else []:
                path = item.get("path") if isinstance(item, dict) else item
                if not isinstance(path, str):
                    continue
                normalized = posixpath.normpath(
                    posixpath.join(posixpath.dirname(name), path)
                )
                if not normalized.startswith("../") and normalized not in seen:
                    pending.append(normalized)
        return files


def _env_path(role):
    return "apps-server/.env" if role == "apps-server" else ".env"


def _env_example(role):
    return (
        "apps-server/.env.example" if role == "apps-server" else ".env.example"
    )


def _missing_settings(git, release, role, env_path):
    example = git.text_at(release, _env_example(role))
    if not example:
        return []
    present = read_env(env_path)
    missing = []
    for line in example.splitlines():
        match = ENV_ASSIGNMENT.match(line)
        if match and match.group(1) not in present:
            missing.append(match.group(1))
    return missing


class _ComposeLoader(yaml.SafeLoader if yaml else object):
    pass


if yaml:
    def _unknown_tag(loader, tag_suffix, node):
        if isinstance(node, yaml.MappingNode):
            return loader.construct_mapping(node, deep=True)
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node, deep=True)
        return loader.construct_scalar(node)

    _ComposeLoader.add_multi_constructor("!", _unknown_tag)


def _compose_document(git, revision, path):
    raw = git.text_at(revision, path)
    if raw is None or yaml is None:
        return {}
    try:
        document = yaml.load(raw, Loader=_ComposeLoader)
    except yaml.YAMLError:
        return {}
    services = document.get("services") if isinstance(document, dict) else None
    return services if isinstance(services, dict) else {}


def _compose_services(git, revision, role, profiles):
    result = {}
    for path in git.compose_files(revision, role):
        services = _compose_document(git, revision, path)
        for name, definition in services.items():
            if not isinstance(name, str) or not isinstance(definition, dict):
                continue
            declared = definition.get("profiles")
            if declared and not set(declared) & profiles:
                continue
            if definition.get("restart") == "no":
                continue
            result[name] = {"definition": definition, "file": path}
    return result


def _build_context(entry):
    build = entry["definition"].get("build")
    if isinstance(build, str):
        context = build
    elif isinstance(build, dict):
        context = build.get("context")
    else:
        context = None
    if not isinstance(context, str) or context.startswith("/"):
        return None
    return posixpath.normpath(posixpath.join(posixpath.dirname(entry["file"]), context))


def affected_services(git, base, target, role, profiles):
    """Services whose effective Compose definition or built code changed."""
    if not base or not target:
        return []
    before = _compose_services(git, base, role, profiles)
    after = _compose_services(git, target, role, profiles)
    changed = {
        name
        for name in before.keys() | after.keys()
        if before.get(name, {}).get("definition") != after.get(name, {}).get("definition")
    }
    contexts = {}
    for name, entry in list(after.items()) + list(before.items()):
        context = _build_context(entry)
        if context:
            contexts.setdefault(name, set()).add(context)
    for path in git.changed_files(base, target):
        for name, roots in contexts.items():
            if any(path == root or path.startswith(root + "/") for root in roots):
                changed.add(name)
    # A replaced VPN namespace recreates every service that shares it.
    while True:
        expanded = changed | {
            name
            for name, entry in list(after.items()) + list(before.items())
            if isinstance(entry["definition"].get("network_mode"), str)
            and entry["definition"]["network_mode"].removeprefix("service:")
            in changed
        }
        if expanded == changed:
            break
        changed = expanded
    return sorted(changed)


def _profiles(env_path):
    return {
        item.strip()
        for item in read_env(env_path).get("COMPOSE_PROFILES", "").split(",")
        if item.strip()
    }


def history_section(appdata):
    state = Path(appdata) / "security-monitor" / "merged-releases"
    entries = []
    try:
        folders = list(state.iterdir())
    except OSError:
        return entries
    for folder in folders:
        if (
            not STATE_FOLDER.fullmatch(folder.name)
            or folder.is_symlink()
            or not folder.is_dir()
        ):
            continue
        result_path = folder / "result.json"
        if result_path.is_symlink():
            continue
        try:
            result = json.loads(result_path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(result, dict):
            continue
        release = _text(result.get("release"), 80)
        if not release or not RELEASE_TAG.fullmatch(release):
            continue
        status = result.get("status")
        outcome = {
            "updated": "success",
            "rolled_back": "rolled-back",
        }.get(status)
        if outcome is None:
            continue
        previous = result.get("previous_installed")
        entries.append(
            {
                "release": release,
                "outcome": outcome,
                "at": _iso(result_path.stat().st_mtime),
                "previousRelease": _text(previous.get("release"), 80)
                if isinstance(previous, dict)
                else None,
                "services": _string_list(result.get("changed")),
            }
        )
    entries.sort(key=lambda entry: entry["at"] or "", reverse=True)
    return entries[:MAX_HISTORY]


def _manifest_state(git, tag, manifest, role):
    """Matches the follower's manifest(): missing, invalid or approved."""
    if not isinstance(manifest, dict):
        return None, "missing"
    if manifest.get("schema") != 1 or manifest.get("approved_merge") is not True:
        return None, "missing"
    roles = manifest.get("roles")
    if not isinstance(roles, list) or role not in roles:
        return None, "missing"
    source = manifest.get("source_commit")
    if not isinstance(source, str) or not COMMIT.fullmatch(source):
        return None, "invalid"
    origin = "refs/remotes/origin/main"
    if git.has_ref(origin) and not git.is_ancestor(tag, origin):
        return None, "invalid"
    if not git.is_ancestor(source, tag):
        return None, "invalid"
    return source, "approved"


class JournalReader:
    """Reads the last journal lines of the allowed units through the host helper."""

    def __init__(self, executor):
        self.executor = executor

    def read(self, units, lines):
        lines = parse_line_count(lines)
        if not units:
            return []
        if not all(
            isinstance(unit, str) and JOURNAL_UNIT.fullmatch(unit) for unit in units
        ):
            raise ValueError("Unidad de journal no válida")
        command = [
            "journalctl",
            "--no-pager",
            "--output=json",
            "--utc",
            "--lines",
            str(lines),
        ]
        for unit in units:
            command.append("--unit=" + unit)
        raw = self.executor.run(command, timeout=10)
        return parse_journal(raw, set(units))


class Deployments:
    """Builds and caches the read-only deployment snapshot for one host."""

    def __init__(
        self,
        *,
        appdata,
        checkout,
        role="instance",
        unit_names=None,
        git=None,
        journal_reader=None,
        clock=time.time,
        cache_seconds=30,
    ):
        self.appdata = Path(appdata)
        self.checkout = Path(checkout)
        self.role = role if role in maintenance.DEFAULT_UNITS else "instance"
        self.unit_names = unit_names or maintenance.parse_unit_names(None, self.role)
        self.journal_units = journal_units(self.unit_names)
        self.git = git or GitReader(self.checkout)
        self.journal = journal_reader or JournalReader(
            maintenance.HostExecutor()
        )
        self.clock = clock
        try:
            self.cache_seconds = max(0.0, float(cache_seconds))
        except (TypeError, ValueError):
            self.cache_seconds = 30.0
        self._cached = None
        self._cached_lines = None
        self._expires = 0.0
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls):
        return cls(
            appdata=os.getenv("APPDATA_ROOT", "/media-stack-appdata"),
            checkout=os.getenv("MEDIA_STACK_ROOT", "/media-stack"),
            role=os.getenv("HOST_ROLE", "instance"),
            unit_names=maintenance.parse_unit_names(
                os.getenv("MAINTENANCE_UNITS"), os.getenv("HOST_ROLE", "instance")
            ),
            cache_seconds=os.getenv("DEPLOYMENTS_CACHE_SECONDS", "30"),
        )

    def snapshot(self, lines=DEFAULT_JOURNAL_LINES):
        lines = parse_line_count(lines)
        now = self.clock()
        with self._lock:
            if (
                self._cached is not None
                and now < self._expires
                and lines == self._cached_lines
            ):
                return self._cached
            value = self._build(now, lines)
            self._cached = value
            self._cached_lines = lines
            self._expires = now + self.cache_seconds
            return value

    def _follower(self, errors):
        try:
            return maintenance.follower_section(self.appdata)
        except Exception:
            errors.append("follower")
            return {
                "available": False,
                "state": "unknown",
                "installed": None,
                "pending": None,
                "failed": None,
            }

    def _retained(self, tags, follower, dirty, errors, history):
        installed = follower.get("installed")
        baseline = _text(installed.get("release"), 80) if installed else None
        if not baseline or not RELEASE_TAG.fullmatch(baseline):
            return []
        baseline_commit = None
        if installed:
            commit = _text(installed.get("commit"), 40)
            baseline_commit = commit if commit and COMMIT.fullmatch(commit) else None
        candidates = [tag for tag in tags if version(tag) > version(baseline)]
        if not candidates:
            return []
        env_path = self.checkout / _env_path(self.role)
        profiles = _profiles(env_path)
        pinned = configuration_key(
            env_path, self.appdata / "security-monitor" / "images.compose.json"
        )
        failed = follower.get("failed") or {}
        failed_release = failed.get("release") if isinstance(failed, dict) else None
        same_failure = (
            isinstance(pinned, str)
            and _failed_configuration(self.appdata) == pinned
        )
        services_by_release = {
            entry["release"]: entry["services"] for entry in history
        }
        global_reason = None
        if follower.get("pending"):
            global_reason = "release-recovery-pending"
        elif (self.appdata / "security-monitor/active-update.json").is_file():
            global_reason = "security-recovery-pending"
        elif not self.git.available():
            global_reason = "checkout-unavailable"
        elif dirty:
            global_reason = "dirty-checkout"
        retained = []
        aborting = None
        for release in candidates:
            notes = self.git.text_at(release, f"docs/releases/{release}.md")
            manifest = self.git.json_at(
                release, f"docs/releases/{release}.deploy.json"
            )
            source, manifest_state = _manifest_state(
                self.git, release, manifest, self.role
            )
            missing = _missing_settings(
                self.git, release, self.role, env_path
            )
            reason = global_reason
            if reason is None and aborting:
                reason = "blocked-by-previous-release"
            if reason is None and manifest_state == "missing":
                reason = "missing-manifest"
            if reason is None and manifest_state == "invalid":
                reason = "invalid-manifest"
            if reason is None and missing:
                reason = "missing-configuration"
            if reason is None and same_failure and failed_release == release:
                reason = "previously-failed"
            if reason is None:
                continue
            services = services_by_release.get(release)
            if services is None:
                base = baseline_commit or self.git.commit(baseline)
                try:
                    services = affected_services(
                        self.git, base, release, self.role, profiles
                    )
                except GitError:
                    services = []
                    errors.append("git")
            retained.append(
                {
                    "release": release,
                    "reason": reason,
                    "blockedBy": aborting if reason == "blocked-by-previous-release" else None,
                    "breaking": breaking_changes(notes),
                    "manualSteps": manual_steps(notes),
                    "missingSettings": missing,
                    "services": services,
                    "sourceCommit": source,
                    "at": self.git.commit_date(release),
                }
            )
            if reason in ("missing-configuration", "invalid-manifest"):
                aborting = release
            if len(retained) >= MAX_RETAINED:
                break
        retained.sort(key=lambda entry: version(entry["release"]), reverse=True)
        return retained

    def _blocker(self, follower, dirty, retained):
        pending = follower.get("pending")
        if pending:
            return {
                "code": "release-recovery-pending",
                "release": _text(pending.get("release"), 80),
                "files": [],
                "missingSettings": [],
            }
        if (self.appdata / "security-monitor/active-update.json").is_file():
            return {
                "code": "security-recovery-pending",
                "release": None,
                "files": [],
                "missingSettings": [],
            }
        if not self.git.available():
            return {
                "code": "checkout-unavailable",
                "release": None,
                "files": [],
                "missingSettings": [],
            }
        if dirty:
            return {
                "code": "dirty-checkout",
                "release": None,
                "files": dirty[:MAX_STATUS_FILES],
                "missingSettings": [],
            }
        held = next(
            (
                entry
                for entry in reversed(retained)
                if entry["reason"] == "missing-configuration"
            ),
            None,
        )
        if held:
            return {
                "code": "missing-configuration",
                "release": held["release"],
                "files": [],
                "missingSettings": held["missingSettings"],
            }
        return None

    def _build(self, now, lines):
        errors = []
        follower = self._follower(errors)
        dirty = []
        tags = []
        if self.git.available():
            try:
                tags = self.git.tags()
            except GitError:
                errors.append("git")
            try:
                dirty = self.git.status()
            except GitError:
                errors.append("git")
        else:
            errors.append("checkout")
        history = history_section(self.appdata)
        try:
            retained = self._retained(tags, follower, dirty, errors, history)
        except GitError:
            errors.append("git")
            retained = []
        journal = []
        try:
            journal = clean_journal(
                self.journal.read(self.journal_units, lines),
                set(self.journal_units),
            )
        except Exception:
            errors.append("journal")
        return {
            "timestamp": now,
            "role": self.role,
            "available": self.git.available(),
            "follower": follower,
            "blocker": self._blocker(follower, dirty, retained),
            "history": history,
            "retained": retained,
            "journal": {"entries": journal},
            "degraded": list(dict.fromkeys(errors)),
        }


def _failed_configuration(appdata):
    try:
        value = json.loads(
            (
                Path(appdata)
                / "security-monitor/merged-releases/failed-release.json"
            ).read_text()
        )
    except (OSError, ValueError):
        return None
    return value.get("configuration") if isinstance(value, dict) else None
