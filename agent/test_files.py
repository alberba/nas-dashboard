import ctypes
import os
from pathlib import Path
import tempfile
import unittest
import server


class FileBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "media"
        self.root.mkdir()
        self.old = server.ROOTS
        server.ROOTS = {"media": self.root}
        (self.root / "movie.mkv").write_bytes(b"test movie")

    def tearDown(self):
        server.ROOTS = self.old
        self.temp.cleanup()

    def test_traversal_absolute_and_root_are_rejected(self):
        for path in ("../private", "/etc/passwd", "a/../../private", ".hub-trash/item", ""):
            with self.subTest(path=path), self.assertRaises(ValueError):
                server.checked_path("media", path)

    def test_symlink_parent_and_leaf_are_rejected(self):
        outside = self.base / "private"
        outside.mkdir()
        (self.root / "escape").symlink_to(outside)
        for path in ("escape", "escape/secret"):
            with self.assertRaises(ValueError):
                server.checked_path("media", path)

    def test_trash_preserves_contents_and_hides_internal_folder(self):
        record = server.trash_item("media", "movie.mkv")
        self.assertFalse((self.root / "movie.mkv").exists())
        self.assertEqual((self.root / ".hub-trash" / record["id"] / "data").read_bytes(), b"test movie")
        self.assertEqual(len(server.trash_records()), 1)
        self.assertFalse(any(f["name"] == ".hub-trash" for f in server.files("media", "")))
        self.assertAlmostEqual(record["expiresAt"] - record["deletedAt"], 7 * 86400, delta=1)

    @unittest.skipUnless(hasattr(ctypes.CDLL(None), "renameat2"), "Linux NAS operation")
    def test_restore_never_overwrites_existing_file(self):
        record = server.trash_item("media", "movie.mkv")
        target = self.root / "movie.mkv"
        target.write_bytes(b"new movie")
        with self.assertRaises(ValueError):
            server.trash_action("media", record["id"], True)
        self.assertEqual(target.read_bytes(), b"new movie")
        target.unlink()
        server.trash_action("media", record["id"], True)
        self.assertEqual(target.read_bytes(), b"test movie")

    @unittest.skipUnless(hasattr(ctypes.CDLL(None), "renameat2"), "Linux NAS operation")
    def test_move_never_overwrites_and_rejects_symlink_destination(self):
        (self.root / "existing").write_bytes(b"keep")
        with self.assertRaises(ValueError):
            server.move_file("media", "movie.mkv", "existing")
        (self.root / "dangling").symlink_to(self.base / "missing")
        with self.assertRaises(ValueError):
            server.move_file("media", "movie.mkv", "dangling")
        server.move_file("media", "movie.mkv", "renamed.mkv")
        self.assertEqual((self.root / "renamed.mkv").read_bytes(), b"test movie")

    def test_protected_container_and_invalid_actions(self):
        for body in ({"action": "stop", "id": "bad;reboot"}, {"action": "exec"}):
            with self.assertRaises(ValueError):
                server.execute(body)


if __name__ == "__main__":
    unittest.main()
