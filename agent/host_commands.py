"""Closed whitelist of privileged host commands.

Every command has a fixed argv. The request only carries the command name, so
no request value can become a unit name, an option or a shell argument.
"""
from __future__ import annotations

import re

UNIT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}$")

DEFAULT_UNITS = {
    "instance": {
        "follower": "media-stack-merged-updates",
        "security": "media-stack-security-updates",
    },
    "apps-server": {
        "follower": "media-stack-apps-merged-updates",
        "security": "media-stack-apps-security-updates",
    },
}
# Keep the command names in sync with src/lib/host-command-contract.ts.


class CommandFailed(OSError):
    """The helper ran but the host command failed; state may have changed."""


class HostCommands:
    """Maps a command name to one fixed systemctl invocation for this role."""

    def __init__(self, *, role="instance", unit_names=None, executor, timeout=15):
        self.role = role if role in DEFAULT_UNITS else "instance"
        self.executor = executor
        self.timeout = timeout
        defaults = DEFAULT_UNITS[self.role]
        configured = (
            list(unit_names)
            if unit_names is not None
            else [defaults["follower"], defaults["security"]]
        )
        self.follower = self._unit(configured, "merged-updates")
        self.security = self._unit(configured, "security-updates")

    @staticmethod
    def _unit(names, marker):
        for name in names:
            if not isinstance(name, str):
                continue
            for suffix in (".service", ".timer"):
                if name.endswith(suffix):
                    name = name[: -len(suffix)]
            if marker in name and UNIT_NAME.fullmatch(name):
                return name
        return None

    def argv(self, command):
        """Returns the only argv this command can run, or rejects the name."""
        if command == "deploy-now":
            return self._service_argv(self.follower, "start")
        if command == "pause-follower":
            return self._timer_argv(self.follower, "disable")
        if command == "resume-follower":
            return self._timer_argv(self.follower, "enable")
        if command == "run-security":
            return self._service_argv(self.security, "start")
        raise ValueError("Comando de host no permitido")

    @staticmethod
    def _service_argv(unit, action):
        if not unit:
            raise ValueError("La unidad del comando no está configurada")
        return ["systemctl", action, "--no-block", unit + ".service"]

    @staticmethod
    def _timer_argv(unit, action):
        if not unit:
            raise ValueError("La unidad del comando no está configurada")
        return ["systemctl", action, "--now", unit + ".timer"]

    def execute(self, command):
        argv = self.argv(command)
        status, _ = self.executor.run_status(argv, timeout=self.timeout)
        if status != 0:
            raise CommandFailed("El comando de host no terminó correctamente")
        return {"command": command, "status": "success"}
