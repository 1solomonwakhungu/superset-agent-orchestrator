import datetime as dt
import os
import plistlib
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import cleanup


class CleanupTests(unittest.TestCase):
    def temporary_directory(self) -> tempfile.TemporaryDirectory[str]:
        return tempfile.TemporaryDirectory(dir=Path(__file__).parent)

    def test_children_older_than_only_returns_stale_direct_children(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            old = root / "old"
            fresh = root / "fresh"
            old.write_text("old")
            fresh.write_text("fresh")
            now = time.time()
            os.utime(old, (now - 2 * cleanup.DAY, now - 2 * cleanup.DAY))

            self.assertEqual(list(cleanup.children_older_than(root, cleanup.DAY, now)), [old])

    def test_children_older_than_accepts_configured_symlink_root(self) -> None:
        with self.temporary_directory() as directory:
            base = Path(directory)
            target = base / "private-tmp"
            target.mkdir()
            stale = target / "stale"
            stale.write_text("old")
            root = base / "tmp"
            root.symlink_to(target, target_is_directory=True)
            now = time.time()
            os.utime(stale, (now - 2 * cleanup.DAY, now - 2 * cleanup.DAY))

            self.assertEqual(list(cleanup.children_older_than(root, cleanup.DAY, now)), [root / "stale"])

    def test_children_older_than_preserves_tree_with_fresh_descendant(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            old_tree = root / "old-tree"
            old_tree.mkdir()
            fresh = old_tree / "fresh"
            fresh.write_text("keep")
            now = time.time()
            os.utime(old_tree, (now - 2 * cleanup.DAY, now - 2 * cleanup.DAY))

            self.assertEqual(list(cleanup.children_older_than(root, cleanup.DAY, now)), [])
            report = cleanup.Report(dry_run=False)
            cleanup.clean_children(root, cleanup.DAY, now, report)
            self.assertTrue(fresh.exists())

    def test_remove_path_refuses_root_and_outside_paths(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory) / "root"
            root.mkdir()
            report = cleanup.Report(dry_run=False)

            cleanup.remove_path(root, root, report)
            cleanup.remove_path(Path(directory) / "outside", root, report)

            self.assertTrue(root.exists())
            self.assertEqual(len(report.errors), 2)

    def test_clean_cache_does_not_follow_root_symlink(self) -> None:
        with self.temporary_directory() as directory:
            base = Path(directory)
            target = base / "target"
            target.mkdir()
            valuable = target / "valuable"
            valuable.write_text("keep")
            link = base / "cache"
            link.symlink_to(target, target_is_directory=True)

            cleanup.clean_cache(link, cleanup.Report(dry_run=False))

            self.assertTrue(valuable.exists())

    def test_dry_run_records_but_does_not_remove(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            item = root / "cache-entry"
            item.write_text("data")
            report = cleanup.Report(dry_run=True)

            cleanup.clean_cache(root, report)

            self.assertTrue(item.exists())
            self.assertEqual(report.removed, [str(item)])
            self.assertGreater(report.candidate_bytes, 0)

    def test_failed_removal_is_not_reported_as_removed(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            item = root / "cache-entry"
            item.write_text("data")
            report = cleanup.Report(dry_run=False)

            with patch.object(Path, "unlink", side_effect=OSError("denied")):
                cleanup.remove_path(item, root, report)

            self.assertEqual(report.removed, [])
            self.assertEqual(len(report.errors), 1)

    def test_failed_download_move_is_not_reported_as_moved(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            downloads = root / "Downloads"
            downloads.mkdir()
            source = downloads / "old.txt"
            source.write_text("data")
            now = time.time()
            os.utime(source, (now - 31 * cleanup.DAY, now - 31 * cleanup.DAY))
            report = cleanup.Report(dry_run=False)

            with patch("cleanup.shutil.move", side_effect=OSError("denied")):
                cleanup.move_old_downloads(downloads, root / ".Trash", now, report)

            self.assertEqual(report.moved, [])
            self.assertEqual(len(report.errors), 1)

    def test_download_move_refuses_symlink_outside_downloads(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            downloads = root / "Downloads"
            downloads.mkdir()
            valuable = root / "valuable.txt"
            valuable.write_text("keep")
            source = downloads / "old.txt"
            source.symlink_to(valuable)
            now = time.time()
            os.utime(source, (now - 31 * cleanup.DAY, now - 31 * cleanup.DAY), follow_symlinks=False)
            report = cleanup.Report(dry_run=False)

            cleanup.move_old_downloads(downloads, root / ".Trash", now, report)

            self.assertTrue(source.is_symlink())
            self.assertTrue(valuable.exists())
            self.assertEqual(report.moved, [])
            self.assertEqual(len(report.errors), 1)

    def test_download_move_uses_unique_destination(self) -> None:
        with self.temporary_directory() as directory:
            root = Path(directory)
            downloads = root / "Downloads"
            trash = root / ".Trash"
            downloads.mkdir()
            trash.mkdir()
            source = downloads / "old.txt"
            source.write_text("new")
            now = time.time()
            os.utime(source, (now - 31 * cleanup.DAY, now - 31 * cleanup.DAY))
            stamp = dt.datetime.fromtimestamp(now, dt.UTC).strftime("%Y%m%d-%H%M%S")
            (trash / "old.txt").write_text("existing")
            (trash / f"old-{stamp}-1.txt").write_text("existing")
            report = cleanup.Report(dry_run=False)

            cleanup.move_old_downloads(downloads, trash, now, report)

            destination = trash / f"old-{stamp}-2.txt"
            self.assertEqual(destination.read_text(), "new")
            self.assertEqual(report.moved, [f"{source} -> {destination}"])

    def test_mounted_images_only_accepts_small_dmg_with_mount(self) -> None:
        with self.temporary_directory() as directory:
            mount = Path(directory) / "App"
            mount.mkdir()
            (mount / "App.app").mkdir()
            payload = {
                "images": [
                    {
                        "image-path": "/Users/me/Downloads/App.dmg",
                        "size": 1000,
                        "system-entities": [{"dev-entry": "/dev/disk9", "mount-point": str(mount)}],
                    },
                    {
                        "image-path": "/dev/external",
                        "size": 1000,
                        "system-entities": [{"dev-entry": "/dev/disk8", "mount-point": str(mount)}],
                    },
                ]
            }
            completed = subprocess.CompletedProcess([], 0, plistlib.dumps(payload), b"")
            with patch("cleanup.shutil.which", return_value="/usr/bin/hdiutil"), patch(
                "cleanup.run", return_value=completed
            ):
                installers, skipped = cleanup.mounted_installer_images()

            expected = f"/Users/me/Downloads/App.dmg ({mount})"
            self.assertEqual(installers, [("/dev/disk9", expected)])
            self.assertEqual(len(skipped), 1)

    def test_mounted_images_handles_malformed_plist_fields(self) -> None:
        payload = {"images": ["invalid", {"image-path": "/tmp/App.dmg", "system-entities": "invalid"}]}
        completed = subprocess.CompletedProcess([], 0, plistlib.dumps(payload), b"")
        with patch("cleanup.shutil.which", return_value="/usr/bin/hdiutil"), patch(
            "cleanup.run", return_value=completed
        ):
            installers, skipped = cleanup.mounted_installer_images()

        self.assertEqual(installers, [])
        self.assertEqual(len(skipped), 2)

    def test_queue_status_never_modifies_invalid_queue(self) -> None:
        with self.temporary_directory() as directory:
            queue = Path(directory) / "queue.json"
            queue.write_text("not json")

            status = cleanup.queue_status(queue, time.time())

            self.assertIn("manual review", status)
            self.assertEqual(queue.read_text(), "not json")

    def test_queue_status_handles_non_utf8_queue(self) -> None:
        with self.temporary_directory() as directory:
            queue = Path(directory) / "queue.json"
            queue.write_bytes(b"\xff")

            status = cleanup.queue_status(queue, time.time())

            self.assertIn("manual review", status)
            self.assertEqual(queue.read_bytes(), b"\xff")

    def test_trusted_tmpdir_rejects_untrusted_location(self) -> None:
        self.assertIsNone(cleanup.trusted_tmpdir(str(Path.home())))
        self.assertIsNone(cleanup.trusted_tmpdir("/"))

    def test_trusted_tmpdir_accepts_macos_per_user_temp_shape(self) -> None:
        path = "/private/var/folders/zz/example/T"
        self.assertEqual(cleanup.trusted_tmpdir(path), Path(path))


if __name__ == "__main__":
    unittest.main()
