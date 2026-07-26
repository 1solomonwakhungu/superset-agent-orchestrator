#!/usr/bin/env python3
"""Conservative macOS cleanup with a human-readable report.

Dry-run is the default. Pass --execute only after reviewing the proposed paths.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import plistlib
import shutil
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

DAY = 24 * 60 * 60
MAX_INSTALLER_BYTES = 5 * 1024**3


@dataclass
class Report:
    dry_run: bool
    before_free: int = 0
    after_free: int = 0
    removed: list[str] = field(default_factory=list)
    moved: list[str] = field(default_factory=list)
    ejected: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    candidate_bytes: int = 0

    @property
    def freed(self) -> int:
        return max(0, self.after_free - self.before_free)


def format_bytes(value: int) -> str:
    size = float(value)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if size < 1024 or unit == "TiB":
            return f"{size:.1f} {unit}"
        size /= 1024
    raise AssertionError("unreachable")


def is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, RuntimeError, ValueError):
        return False


def children_older_than(root: Path, age_seconds: int, now: float) -> Iterable[Path]:
    if not root.is_dir():
        return []
    result: list[Path] = []
    try:
        children = list(root.iterdir())
    except OSError:
        return []
    for child in children:
        try:
            if now - child.lstat().st_mtime > age_seconds:
                result.append(child)
        except OSError:
            continue
    return result


def remove_path(path: Path, allowed_root: Path, report: Report) -> None:
    if path == allowed_root or not is_within(path, allowed_root):
        report.errors.append(f"refused unsafe removal: {path}")
        return
    if report.dry_run:
        report.removed.append(str(path))
        report.candidate_bytes += path_size(path)
        return
    try:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.is_dir():
            shutil.rmtree(path)
        else:
            report.skipped.append(f"removal candidate disappeared: {path}")
            return
        report.removed.append(str(path))
    except OSError as exc:
        report.errors.append(f"remove {path}: {exc}")


def clean_children(root: Path, age_seconds: int, now: float, report: Report) -> None:
    for path in children_older_than(root, age_seconds, now):
        remove_path(path, root, report)


def clean_cache(root: Path, report: Report) -> None:
    if not root.is_dir() or root.is_symlink():
        return
    try:
        children = list(root.iterdir())
    except OSError as exc:
        report.errors.append(f"list {root}: {exc}")
        return
    for path in children:
        remove_path(path, root, report)


def move_old_downloads(downloads: Path, trash: Path, now: float, report: Report) -> None:
    if downloads.is_symlink() or not downloads.is_dir():
        report.skipped.append(f"Downloads unavailable or symlinked: {downloads}")
        return
    if trash.is_symlink():
        report.errors.append(f"refused symlinked Trash: {trash}")
        return
    if not report.dry_run:
        try:
            trash.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            report.errors.append(f"create Trash {trash}: {exc}")
            return
    for source in children_older_than(downloads, 30 * DAY, now):
        if not is_within(source, downloads):
            report.errors.append(f"refused download outside configured root: {source}")
            continue
        destination = trash / source.name
        suffix = 0
        while os.path.lexists(destination):
            suffix += 1
            stamp = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
            destination = trash / f"{source.stem}-{stamp}-{suffix}{source.suffix}"
        move_description = f"{source} -> {destination}"
        if report.dry_run:
            report.moved.append(move_description)
            continue
        try:
            shutil.move(str(source), str(destination))
            report.moved.append(move_description)
        except OSError as exc:
            report.errors.append(f"move {source}: {exc}")


def run(command: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(command, capture_output=True, check=False)


def mounted_installer_images() -> tuple[list[tuple[str, str]], list[str]]:
    """Return verified installer image devices and descriptions of skipped images."""
    if shutil.which("hdiutil") is None:
        return [], ["hdiutil unavailable; disk image inspection skipped"]
    try:
        result = run(["hdiutil", "info", "-plist"])
    except OSError as exc:
        return [], [f"hdiutil inspection failed: {exc}"]
    if result.returncode != 0:
        return [], [f"hdiutil inspection failed: {result.stderr.decode(errors='replace').strip()}"]
    try:
        payload = plistlib.loads(result.stdout)
        images = payload.get("images", [])
        if not isinstance(images, list):
            raise TypeError("images is not a list")
    except (AttributeError, plistlib.InvalidFileException, TypeError, ValueError) as exc:
        return [], [f"invalid hdiutil output: {exc}"]

    installers: list[tuple[str, str]] = []
    skipped: list[str] = []
    for image in images:
        if not isinstance(image, dict):
            skipped.append("malformed hdiutil image entry")
            continue
        image_path = str(image.get("image-path", ""))
        entities = image.get("system-entities", [])
        if not isinstance(entities, list):
            skipped.append(f"{image_path or 'unknown image'}: malformed system entities")
            continue
        entities = [item for item in entities if isinstance(item, dict)]
        devices = [
            str(item["dev-entry"])
            for item in entities
            if item.get("mount-point") and item.get("dev-entry")
        ]
        mounts = [str(item.get("mount-point", "")) for item in entities if item.get("mount-point")]
        try:
            size = int(image.get("size", image.get("total-bytes", 0)) or 0)
        except (TypeError, ValueError):
            size = 0
        if not size and image_path:
            try:
                size = Path(image_path).stat().st_size
            except OSError:
                pass
        description = f"{image_path or 'unknown image'} ({', '.join(mounts) or 'not mounted'})"
        installer_content = False
        if len(mounts) == 1:
            try:
                installer_content = any(
                    child.suffix.lower() in {".app", ".pkg"} for child in Path(mounts[0]).iterdir()
                )
            except OSError:
                pass
        verified = (
            image_path.lower().endswith(".dmg")
            and bool(devices)
            and 0 < size < MAX_INSTALLER_BYTES
            and installer_content
        )
        if verified:
            installers.append((devices[0], description))
        elif mounts:
            skipped.append(f"{description}: no conclusive small-DMG application installer evidence")
    return installers, skipped


def eject_installers(report: Report) -> None:
    installers, skipped = mounted_installer_images()
    report.skipped.extend(skipped)
    for device, description in installers:
        if report.dry_run:
            report.ejected.append(f"would eject {device}: {description}")
            continue
        try:
            result = run(["hdiutil", "detach", device])
        except OSError as exc:
            report.errors.append(f"eject {device}: {exc}")
            continue
        if result.returncode == 0:
            report.ejected.append(f"{device}: {description}")
        else:
            report.errors.append(f"eject {device}: {result.stderr.decode(errors='replace').strip()}")


def path_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file() or path.is_symlink():
        try:
            return path.lstat().st_size
        except OSError:
            return 0
    total = 0
    try:
        for root, _, files in os.walk(path):
            for name in files:
                try:
                    total += (Path(root) / name).stat().st_size
                except OSError:
                    pass
    except OSError:
        return 0
    return total


def directory_size(path: Path) -> int | None:
    return path_size(path) if path.exists() else None


def queue_status(path: Path, now: float) -> str:
    if not path.exists():
        return "overnight queue absent"
    try:
        age_days = (now - path.stat().st_mtime) / DAY
        json.loads(path.read_text(encoding="utf-8"))
        return f"overnight queue valid JSON, modified {age_days:.1f} days ago; left unchanged"
    except (OSError, json.JSONDecodeError) as exc:
        return f"overnight queue requires manual review and was left unchanged: {exc}"


def render(report: Report, home: Path, now: float) -> str:
    hermes = home / "Documents/Hermes"
    lines = [
        f"Mode: {'dry-run' if report.dry_run else 'execute'}",
        f"Disk free before: {format_bytes(report.before_free)}",
        f"Disk free after: {format_bytes(report.after_free)}",
        f"Disk space freed: {format_bytes(report.freed)}",
        f"Estimated removal candidates: {format_bytes(report.candidate_bytes)}" if report.dry_run else "",
        queue_status(hermes / "artifacts/overnight_task_queue.json", now),
    ]
    lines = [line for line in lines if line]
    if hermes.is_dir():
        for child in sorted(hermes.iterdir()):
            size = directory_size(child)
            if size is not None:
                lines.append(f"Hermes usage {child.name}: {format_bytes(size)}")
    model_locations = [home / ".cache/lm-studio/models", home / ".lmstudio/models"]
    for location in model_locations:
        size = directory_size(location)
        if size is not None:
            lines.append(f"LM Studio models (not deleted) {location}: {format_bytes(size)}")
    for heading, values in (
        ("Proposed removals" if report.dry_run else "Removed", report.removed),
        ("Moved to Trash", report.moved),
        ("Installer images", report.ejected),
        ("Skipped", report.skipped),
        ("Errors", report.errors),
    ):
        lines.append(f"\n{heading} ({len(values)}):")
        lines.extend(f"- {value}" for value in values)
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="perform removals instead of a dry-run")
    parser.add_argument("--include-downloads", action="store_true", help="move Downloads older than 30 days to Trash")
    parser.add_argument("--empty-trash", action="store_true", help="empty Trash (requires --execute)")
    parser.add_argument("--docker-prune", action="store_true", help="run docker system prune -f (requires --execute)")
    parser.add_argument("--eject-installers", action="store_true", help="detach conclusively identified mounted DMGs")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    home = Path.home()
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    report = Report(dry_run=not args.execute)
    report.before_free = shutil.disk_usage("/").free

    cleanup_roots = [
        (Path("/tmp"), DAY),
        (Path("/var/tmp"), 7 * DAY),
        (Path(os.environ.get("TMPDIR", "/tmp")), DAY),
        (home / ".hermes/cron/output", 7 * DAY),
        (home / ".hermes/logs", 7 * DAY),
        (home / ".hermes/tmp", DAY),
    ]
    seen: set[Path] = set()
    for root, age in cleanup_roots:
        try:
            resolved = root.resolve()
        except (OSError, RuntimeError) as exc:
            report.errors.append(f"resolve cleanup root {root}: {exc}")
            continue
        if resolved not in seen:
            clean_children(root, age, now, report)
            seen.add(resolved)

    cache_roots = [
        home / "Library/Caches/go-build",
        home / ".cache/pip",
        home / ".cache/uv",
        home / ".npm/_cacache",
        home / ".cache/yarn",
        home / ".gradle/caches",
    ]
    for root in cache_roots:
        clean_cache(root, report)
    report.skipped.append("~/Library/Caches broad cleanup: only known build/package caches are eligible")

    if args.include_downloads:
        move_old_downloads(home / "Downloads", home / ".Trash", now, report)
    else:
        report.skipped.append("old Downloads: requires --include-downloads after review")
    if args.empty_trash:
        clean_cache(home / ".Trash", report)
    else:
        report.skipped.append("Trash: requires --empty-trash after review")

    if args.docker_prune:
        if report.dry_run:
            report.skipped.append("docker system prune -f: would run in execute mode")
        elif shutil.which("docker"):
            try:
                result = run(["docker", "system", "prune", "-f"])
                if result.returncode != 0:
                    report.errors.append(f"docker prune: {result.stderr.decode(errors='replace').strip()}")
            except OSError as exc:
                report.errors.append(f"docker prune: {exc}")
        else:
            report.skipped.append("Docker unavailable")
    if args.eject_installers:
        eject_installers(report)
    else:
        report.skipped.append("mounted installer inspection/ejection: requires --eject-installers")

    report.after_free = shutil.disk_usage("/").free
    print(render(report, home, now))
    return 1 if report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
