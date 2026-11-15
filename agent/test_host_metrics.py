import tempfile
import unittest
from pathlib import Path

import host_metrics


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


STAT_FIRST = """cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
cpu1 50 0 25 400 25 0 0 0 0 0
"""

STAT_SECOND = """cpu  200 0 100 1000 100 0 0 0 0 0
cpu0 100 0 50 600 50 0 0 0 0 0
cpu1 100 0 50 600 100 0 0 0 0 0
"""

NET_FIRST = """Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0
tailscale0: 300 0 0 0 0 0 0 0 400 0 0 0 0 0 0 0
    lo: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0
"""

NET_SECOND = """Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 2000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0
tailscale0: 500 0 0 0 0 0 0 0 900 0 0 0 0 0 0 0
    lo: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0
"""

DISK_FIRST = """   8       0 sda 100 0 1000 100 50 0 500 50 0 200 250
 259       0 nvme0n1 200 0 2000 200 100 0 1000 100 0 300 400
"""

DISK_SECOND = """   8       0 sda 110 0 1100 120 55 0 550 60 0 250 310
 259       0 nvme0n1 220 0 2200 230 110 0 1100 120 0 380 500
"""

MEMINFO = """MemTotal: 1000000 kB
MemFree: 200000 kB
MemAvailable: 600000 kB
Buffers: 50000 kB
Cached: 100000 kB
SReclaimable: 20000 kB
SwapTotal: 500000 kB
SwapFree: 300000 kB
"""


def core_files(proc, *, stat=STAT_FIRST, net=NET_FIRST, disk=DISK_FIRST):
    write(proc / "stat", stat)
    write(proc / "loadavg", "0.50 0.60 0.70 1/123 456\n")
    write(proc / "meminfo", MEMINFO)
    write(proc / "net" / "dev", net)
    write(proc / "diskstats", disk)
    write(proc / "uptime", "12345.67 999.00\n")


class Clock:
    def __init__(self, *values):
        self.values = list(values)

    def __call__(self):
        return self.values.pop(0)


class HostSampleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.proc = self.base / "proc"
        self.sys = self.base / "sys"
        self.root = self.base / "media"
        self.root.mkdir()
        core_files(self.proc)

    def tearDown(self):
        self.temp.cleanup()

    def sample(self, sampler, roots=None, extra=None):
        return sampler.sample(self.proc, self.sys, roots or {}, extra or [])

    def test_first_sample_reports_static_values_and_leaves_rates_empty(self):
        sample = self.sample(host_metrics.HostSampler(clock=Clock(1000)))

        self.assertEqual(sample["timestamp"], 1000)
        self.assertIsNone(sample["cpu"])
        self.assertIsNone(sample["cpuCores"])
        self.assertIsNone(sample["cpuBreakdown"])
        self.assertEqual(sample["load"], [0.5, 0.6, 0.7])
        self.assertEqual(sample["memory"]["total"], 1_024_000_000)
        self.assertEqual(sample["memory"]["used"], 409_600_000)
        self.assertEqual(sample["memory"]["cache"], 174_080_000)
        self.assertEqual(sample["memory"]["swap"], {"total": 512_000_000, "used": 204_800_000})
        self.assertIsNone(sample["network"]["rx"])
        self.assertIsNone(sample["network"]["tx"])
        self.assertEqual(
            [(item["name"], item["rx"], item["tx"]) for item in sample["network"]["interfaces"]],
            [("eth0", None, None), ("tailscale0", None, None)],
        )
        self.assertIsNone(sample["io"]["read"])
        self.assertIsNone(sample["io"]["latency"])
        self.assertEqual(sample["uptime"], 12345.67)
        self.assertEqual(sample["raid"], [])
        self.assertEqual(sample["temperatures"], [])

    def test_second_sample_derives_cpu_network_disk_and_latency(self):
        sampler = host_metrics.HostSampler(clock=Clock(1000, 1010))

        self.sample(sampler)
        write(self.proc / "stat", STAT_SECOND)
        write(self.proc / "net" / "dev", NET_SECOND)
        write(self.proc / "diskstats", DISK_SECOND)
        sample = self.sample(sampler)

        self.assertEqual(sample["cpu"], 37.5)
        self.assertEqual(sample["cpuCores"], [25.0, 21.4])
        self.assertEqual(
            sample["cpuBreakdown"],
            {
                "user": 25.0,
                "system": 12.5,
                "iowait": 12.5,
                "steal": 0.0,
                "idle": 50.0,
                "irq": 0.0,
                "softirq": 0.0,
                "nice": 0.0,
            },
        )
        self.assertEqual(sample["network"]["rx"], 100)
        self.assertEqual(sample["network"]["tx"], 200)
        self.assertEqual(
            [
                (item["name"], item["rx"], item["tx"], item["rxTotal"], item["txTotal"])
                for item in sample["network"]["interfaces"]
            ],
            [
                ("eth0", 100, 200, 2000, 4000),
                ("tailscale0", 20, 50, 500, 900),
            ],
        )
        self.assertEqual(sample["io"]["read"], 15360)
        self.assertEqual(sample["io"]["write"], 7680)
        self.assertEqual(sample["io"]["latency"]["readMs"], 1.67)
        self.assertEqual(sample["io"]["latency"]["writeMs"], 2.0)
        self.assertEqual(sample["io"]["latency"]["utilization"], 0.8)
        self.assertEqual(sample["io"]["latency"]["weightedMs"], 3.56)
        self.assertEqual(
            [
                (item["name"], item["readMs"], item["writeMs"], item["utilization"])
                for item in sample["io"]["latency"]["devices"]
            ],
            [("nvme0n1", 1.5, 2.0, 0.8), ("sda", 2.0, 2.0, 0.5)],
        )

    def test_missing_optional_files_do_not_break_the_sample(self):
        (self.proc / "loadavg").unlink()
        sample = self.sample(host_metrics.HostSampler(clock=Clock(1000)))

        self.assertIsNone(sample["load"])
        self.assertEqual(sample["raid"], [])
        self.assertEqual(sample["temperatures"], [])

    def test_temperatures_use_the_hwmon_label_or_parent_name(self):
        labelled = self.sys / "class" / "hwmon" / "hwmon0"
        write(labelled / "name", "nvme\n")
        write(labelled / "temp1_label", "Composite\n")
        write(labelled / "temp1_input", "42000\n")
        unlabelled = self.sys / "class" / "hwmon" / "hwmon1"
        write(unlabelled / "name", "spd5118\n")
        write(unlabelled / "temp1_input", "46000\n")

        sample = self.sample(host_metrics.HostSampler(clock=Clock(1000)))

        self.assertEqual(
            sample["temperatures"],
            [
                {"name": "Composite", "value": 42.0},
                {"name": "spd5118", "value": 46.0},
            ],
        )

    def test_raid_reads_mdstat_and_sysfs(self):
        write(
            self.proc / "mdstat",
            """Personalities : [raid0] [raid1]
md2 : active raid1 nvme0n1p2[0]
      483975168 blocks super 1.2 [1/1] [U]
md1 : active raid0 sdb2[0] sda2[2] sdc2[1]
      11672656896 blocks super 1.2 64k chunks
unused devices: <none>
""",
        )
        md2 = self.sys / "block" / "md2"
        write(md2 / "size", "967950336\n")
        write(md2 / "md" / "array_state", "active\n")
        write(md2 / "md" / "level", "raid1\n")
        write(md2 / "md" / "raid_disks", "1\n")
        write(md2 / "md" / "degraded", "0\n")
        write(md2 / "md" / "sync_action", "idle\n")
        write(md2 / "md" / "sync_completed", "none\n")
        write(md2 / "md" / "sync_speed", "none\n")
        md1 = self.sys / "block" / "md1"
        write(md1 / "size", "23345313792\n")
        write(md1 / "md" / "array_state", "clean\n")
        write(md1 / "md" / "level", "raid0\n")
        write(md1 / "md" / "raid_disks", "3\n")

        sample = self.sample(host_metrics.HostSampler(clock=Clock(1000)))

        self.assertEqual(
            sample["raid"],
            [
                {
                    "name": "md1",
                    "level": "raid0",
                    "state": "clean",
                    "disks": 3,
                    "capacity": 23345313792 * 512,
                    "degraded": None,
                    "syncAction": None,
                    "syncCompleted": None,
                    "syncSpeed": None,
                },
                {
                    "name": "md2",
                    "level": "raid1",
                    "state": "active",
                    "disks": 1,
                    "capacity": 967950336 * 512,
                    "degraded": 0,
                    "syncAction": "idle",
                    "syncCompleted": "none",
                    "syncSpeed": "none",
                },
            ],
        )

    def test_filesystems_include_roots_and_extras_once(self):
        sample = self.sample(
            host_metrics.HostSampler(clock=Clock(1000)),
            roots={"media": self.root},
        )
        extra = self.sample(
            host_metrics.HostSampler(clock=Clock(1000)),
            extra=[("Datos", self.root)],
        )

        self.assertEqual(sample["filesystems"][0]["name"], "Volumen de películas")
        self.assertGreater(sample["filesystems"][0]["total"], 0)
        self.assertEqual(sample["disks"][0]["root"], "media")
        self.assertEqual(extra["filesystems"][0]["name"], "Datos")
        self.assertEqual(extra["disks"], [])


if __name__ == "__main__":
    unittest.main()
