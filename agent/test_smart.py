import json
import unittest

import smart


class QueueExecutor:
    """Returns the queued smartctl outputs in order and records every command."""

    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.calls = []

    def run(self, argv, timeout=8):
        self.calls.append((list(argv), timeout))
        if not self.outputs:
            raise AssertionError("smartctl called more times than expected")
        output = self.outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        if callable(output):
            return output(argv)
        return output


def scan(*devices):
    return json.dumps(
        {
            "json_format_version": [1, 0],
            "smartctl": {
                "version": [7, 4],
                "svn_revision": "5530",
                "platform_info": "x86_64-linux-6.12.0",
                "build_info": "(local build)",
                "argv": ["smartctl", "--scan-open", "--json"],
                "exit_status": 0,
            },
            "devices": [
                {
                    "name": name,
                    "info_name": name,
                    "type": kind,
                    "protocol": "NVME" if kind == "nvme" else "ATA",
                }
                for name, kind in devices
            ],
        }
    )


def sata(
    name="/dev/sda",
    *,
    model="WDC WD40EFRX-68N32N0",
    serial="WD-WCC7K0XXXXXX",
    temperature=34,
    reallocated=0,
    passed=True,
    with_smart=True,
):
    payload = {
        "json_format_version": [1, 0],
        "smartctl": {
            "version": [7, 4],
            "svn_revision": "5530",
            "platform_info": "x86_64-linux-6.12.0",
            "argv": ["smartctl", "--json", "--all", name],
            "exit_status": 0,
        },
        "device": {
            "name": name,
            "info_name": name,
            "type": "ata",
            "protocol": "ATA",
        },
        "model_name": model,
        "serial_number": serial,
        "firmware_version": "82.00A82",
        "user_capacity": {"blocks": 7814037168, "bytes": 4000787030016},
        "logical_block_size": 512,
        "rotation_rate": 5400,
    }
    if with_smart:
        payload["smart_status"] = {"passed": passed}
        payload["temperature"] = {"current": temperature}
        payload["power_on_time"] = {"hours": 19752}
        payload["ata_smart_attributes"] = {
            "revision": 16,
            "table": [
                {
                    "id": 5,
                    "name": "Reallocated_Sector_Ct",
                    "value": 200,
                    "worst": 200,
                    "thresh": 140,
                    "when_failed": "",
                    "flags": {},
                    "raw": {"value": reallocated, "string": str(reallocated)},
                },
                {
                    "id": 194,
                    "name": "Temperature_Celsius",
                    "value": 118,
                    "worst": 99,
                    "thresh": 0,
                    "when_failed": "",
                    "flags": {},
                    "raw": {"value": temperature, "string": str(temperature)},
                },
            ],
        }
    return json.dumps(payload)


def nvme(
    name="/dev/nvme0n1",
    *,
    model="Samsung SSD 970 EVO Plus 2TB",
    serial="S4EWNX0R123456",
    temperature=41,
    wear=3,
    passed=True,
    critical=0,
    with_smart=True,
):
    payload = {
        "json_format_version": [1, 0],
        "smartctl": {
            "version": [7, 4],
            "svn_revision": "5530",
            "platform_info": "x86_64-linux-6.12.0",
            "argv": ["smartctl", "--json", "--all", name],
            "exit_status": 0,
        },
        "device": {
            "name": name,
            "info_name": name,
            "type": "nvme",
            "protocol": "NVME",
        },
        "model_name": model,
        "serial_number": serial,
        "firmware_version": "2B2QEXM7",
        "user_capacity": {"blocks": 3907029168, "bytes": 2000398934016},
        "logical_block_size": 512,
    }
    if with_smart:
        payload["smart_status"] = {"passed": passed}
        payload["temperature"] = {"current": temperature}
        payload["nvme_smart_health_information_log"] = {
            "critical_warning": critical,
            "temperature": temperature,
            "available_spare": 100,
            "available_spare_threshold": 10,
            "percentage_used": wear,
            "data_units_read": 123456789,
            "data_units_written": 987654321,
            "host_reads": 12345678,
            "host_writes": 87654321,
            "controller_busy_time": 1234,
            "power_cycles": 321,
            "power_on_hours": 12000,
            "unsafe_shutdowns": 7,
            "media_errors": 0,
            "num_err_log_entries": 0,
        }
    return json.dumps(payload)


class SmartMonitorTest(unittest.TestCase):
    def test_reads_three_wd_red_and_two_nvme_from_the_host_scan(self):
        executor = QueueExecutor(
            scan(
                ("/dev/sda", "ata"),
                ("/dev/sdb", "ata"),
                ("/dev/sdc", "ata"),
                ("/dev/nvme0n1", "nvme"),
                ("/dev/nvme1n1", "nvme"),
            ),
            sata("/dev/sda", serial="WD-WCC7K0AAAAAA"),
            sata("/dev/sdb", serial="WD-WCC7K0BBBBBB"),
            sata("/dev/sdc", serial="WD-WCC7K0CCCCCC"),
            nvme("/dev/nvme0n1", serial="S4EWNX0R000001"),
            nvme(
                "/dev/nvme1n1",
                model="Samsung SSD 990 PRO 4TB",
                serial="S6Z1NJ0T000002",
                wear=7,
            ),
        )

        section = smart.SmartMonitor(executor=executor).read()

        self.assertTrue(section["available"])
        self.assertEqual(len(section["devices"]), 5)
        self.assertEqual(
            [device["kind"] for device in section["devices"]],
            ["sata", "sata", "sata", "nvme", "nvme"],
        )
        self.assertEqual(
            [device["device"] for device in section["devices"]],
            ["sda", "sdb", "sdc", "nvme0n1", "nvme1n1"],
        )
        self.assertEqual(
            [device["model"] for device in section["devices"][:3]],
            ["WDC WD40EFRX-68N32N0"] * 3,
        )
        self.assertEqual(section["devices"][0]["size"], 4000787030016)
        self.assertEqual(section["devices"][0]["temperature"], 34)
        self.assertEqual(section["devices"][0]["reallocatedSectors"], 0)
        self.assertIsNone(section["devices"][0]["wear"])
        self.assertEqual(section["devices"][3]["wear"], 3)
        self.assertIsNone(section["devices"][3]["reallocatedSectors"])
        self.assertEqual(section["devices"][3]["size"], 2000398934016)
        self.assertEqual(
            [device["status"] for device in section["devices"]],
            ["ok", "ok", "ok", "ok", "ok"],
        )
        self.assertEqual(executor.calls[0], (["smartctl", "--scan-open", "--json"], 15))
        self.assertEqual(
            executor.calls[1],
            (["smartctl", "--json", "--all", "-d", "ata", "/dev/sda"], 15),
        )
        self.assertEqual(
            executor.calls[4],
            (["smartctl", "--json", "--all", "-d", "nvme", "/dev/nvme0n1"], 15),
        )
        self.assertEqual(len(executor.outputs), 0)

    def test_accepts_the_broadcast_nvme_names_returned_by_the_real_scan(self):
        executor = QueueExecutor(
            scan(("/dev/nvme0", "nvme"), ("/dev/nvme1", "nvme")),
            nvme("/dev/nvme0", serial="S4EWNX0R000001"),
            nvme("/dev/nvme1", serial="S6Z1NJ0T000002"),
        )

        section = smart.SmartMonitor(executor=executor).read()

        self.assertEqual(
            [device["device"] for device in section["devices"]], ["nvme0", "nvme1"]
        )
        self.assertEqual(
            [device["kind"] for device in section["devices"]], ["nvme", "nvme"]
        )
        self.assertEqual(
            executor.calls[1],
            (["smartctl", "--json", "--all", "-d", "nvme", "/dev/nvme0"], 15),
        )

    def test_smartctl_is_only_invoked_with_fixed_read_only_commands(self):
        executor = QueueExecutor(
            scan(("/dev/sda", "ata")),
            sata(),
        )

        smart.SmartMonitor(executor=executor).read()

        for argv, _timeout in executor.calls:
            self.assertEqual(argv[0], "smartctl")
            for forbidden in (
                "-t",
                "--test",
                "-s",
                "--smart",
                "-o",
                "--offlineauto",
                "-S",
                "--saveauto",
                "-X",
                "--abort",
            ):
                self.assertNotIn(forbidden, argv)

    def test_reallocated_sectors_above_the_default_threshold_are_a_warning(self):
        executor = QueueExecutor(scan(("/dev/sda", "ata")), sata(reallocated=1))

        device = smart.SmartMonitor(executor=executor).read()["devices"][0]

        self.assertEqual(device["reallocatedSectors"], 1)
        self.assertEqual(device["status"], "watch")
        self.assertIn("reallocated_threshold", device["issues"])

    def test_an_increase_over_the_previous_reading_is_a_warning_below_the_threshold(self):
        executor = QueueExecutor(
            scan(("/dev/sda", "ata")),
            sata(reallocated=3),
            scan(("/dev/sda", "ata")),
            sata(reallocated=4),
            scan(("/dev/sda", "ata")),
            sata(reallocated=4),
        )
        monitor = smart.SmartMonitor(executor=executor, reallocated_threshold=10)

        first = monitor.read()["devices"][0]
        increased = monitor.read()["devices"][0]
        unchanged = monitor.read()["devices"][0]

        self.assertEqual(first["status"], "ok")
        self.assertNotIn("reallocated_increase", first["issues"])
        self.assertEqual(increased["reallocatedSectors"], 4)
        self.assertEqual(increased["status"], "watch")
        self.assertIn("reallocated_increase", increased["issues"])
        self.assertNotIn("reallocated_threshold", increased["issues"])
        self.assertEqual(unchanged["status"], "ok")

    def test_sata_and_nvme_temperatures_classify_watch_and_failure(self):
        cases = [
            ("sata", sata(temperature=52), "watch", "temperature"),
            ("sata", sata(temperature=66), "fail", "temperature"),
            ("nvme", nvme(temperature=76), "watch", "temperature"),
            ("nvme", nvme(temperature=86), "fail", "temperature"),
        ]
        for kind, payload, expected, issue in cases:
            with self.subTest(kind=kind, expected=expected):
                executor = QueueExecutor(scan(("/dev/sda", kind)), payload)
                device = smart.SmartMonitor(executor=executor).read()["devices"][0]
                self.assertEqual(device["temperature"], json.loads(payload)["temperature"]["current"])
                self.assertEqual(device["status"], expected)
                self.assertIn(issue, device["issues"])

    def test_nvme_wear_classifies_watch_and_failure(self):
        cases = [(95, "watch"), (100, "fail")]
        for wear, expected in cases:
            with self.subTest(wear=wear):
                executor = QueueExecutor(
                    scan(("/dev/nvme0n1", "nvme")),
                    nvme(wear=wear),
                )
                device = smart.SmartMonitor(executor=executor).read()["devices"][0]
                self.assertEqual(device["wear"], wear)
                self.assertEqual(device["status"], expected)
                self.assertIn("wear", device["issues"])

    def test_a_failed_smart_health_result_is_a_failure(self):
        executor = QueueExecutor(scan(("/dev/sda", "ata")), sata(passed=False))

        device = smart.SmartMonitor(executor=executor).read()["devices"][0]

        self.assertEqual(device["status"], "fail")
        self.assertIn("smart_failed", device["issues"])

    def test_a_disk_without_smart_data_is_unknown_and_keeps_the_other_disks(self):
        executor = QueueExecutor(
            scan(("/dev/sdc", "ata"), ("/dev/nvme0n1", "nvme")),
            sata("/dev/sdc", serial="WD-WCC7K0CCCCCC", with_smart=False),
            nvme(with_smart=False),
        )

        section = smart.SmartMonitor(executor=executor).read()

        self.assertTrue(section["available"])
        self.assertEqual(len(section["devices"]), 2)
        unknown = section["devices"][0]
        self.assertEqual(unknown["device"], "sdc")
        self.assertEqual(unknown["model"], "WDC WD40EFRX-68N32N0")
        self.assertIsNone(unknown["temperature"])
        self.assertIsNone(unknown["reallocatedSectors"])
        self.assertIsNone(unknown["wear"])
        self.assertEqual(unknown["status"], "unknown")
        self.assertIn("smart_unavailable", unknown["issues"])
        self.assertEqual(section["devices"][1]["status"], "unknown")

    def test_a_failing_read_leaves_that_disk_unknown_and_does_not_hide_the_others(self):
        executor = QueueExecutor(
            scan(("/dev/sda", "ata"), ("/dev/sdb", "ata")),
            OSError("smartctl could not open the device"),
            sata("/dev/sdb", serial="WD-WCC7K0BBBBBB", temperature=35),
        )

        section = smart.SmartMonitor(executor=executor).read()

        broken, healthy = section["devices"]
        self.assertEqual(broken["device"], "sda")
        self.assertEqual(broken["status"], "unknown")
        self.assertIn("read_failed", broken["issues"])
        self.assertEqual(healthy["status"], "ok")
        self.assertEqual(healthy["temperature"], 35)


if __name__ == "__main__":
    unittest.main()
