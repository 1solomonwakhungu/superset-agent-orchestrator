from __future__ import annotations

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "validate_corpus", ROOT / "scripts" / "validate_corpus.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ValidateCorpusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.corpus = Path(self.temporary.name) / "corpus"
        shutil.copytree(ROOT / "corpus", self.corpus)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def rewrite_manifest(self) -> None:
        manifest_path = self.corpus / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for filename, entry in manifest["files"].items():
            raw = (self.corpus / filename).read_bytes()
            entry.update(
                sha256=MODULE._sha256(raw), bytes=len(raw), items=len(raw.splitlines())
            )
        encoded = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
        manifest_path.write_bytes(encoded)
        (self.corpus / "manifest.sha256").write_text(
            f"{MODULE._sha256(encoded)}  manifest.json\n", encoding="utf-8"
        )

    def mutate_first(self, filename: str, mutate) -> None:
        path = self.corpus / filename
        lines = path.read_text(encoding="utf-8").splitlines()
        item = json.loads(lines[0])
        mutate(item)
        lines[0] = json.dumps(item, separators=(",", ":"), sort_keys=True)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.rewrite_manifest()

    def test_repository_corpus_is_valid(self) -> None:
        counts = MODULE.validate_corpus(ROOT / "corpus")
        self.assertEqual(sum(counts.values()), 15)
        self.assertEqual(set(counts), MODULE.DOMAINS)

    def test_rejects_hash_drift(self) -> None:
        path = self.corpus / "reasoning.jsonl"
        path.write_bytes(path.read_bytes().replace(b"workshop", b"factory", 1))
        with self.assertRaisesRegex(MODULE.CorpusValidationError, "manifest mismatch"):
            MODULE.validate_corpus(self.corpus)

    def test_rejects_duplicate_ids(self) -> None:
        first_id = json.loads(
            (self.corpus / "reasoning.jsonl").read_text(encoding="utf-8").splitlines()[0]
        )["id"]
        self.mutate_first("code.jsonl", lambda item: item.update(id=first_id))
        with self.assertRaisesRegex(MODULE.CorpusValidationError, "duplicate id"):
            MODULE.validate_corpus(self.corpus)

    def test_rejects_missing_gold_or_verifier(self) -> None:
        self.mutate_first("reasoning.jsonl", lambda item: item.pop("gold"))
        with self.assertRaisesRegex(MODULE.CorpusValidationError, "exactly one"):
            MODULE.validate_corpus(self.corpus)

    def test_rejects_unapproved_license(self) -> None:
        self.mutate_first("reasoning.jsonl", lambda item: item.update(license="unknown"))
        with self.assertRaisesRegex(MODULE.CorpusValidationError, "unapproved license"):
            MODULE.validate_corpus(self.corpus)

    def test_rejects_unknown_fields(self) -> None:
        self.mutate_first("reasoning.jsonl", lambda item: item.update(extra=True))
        with self.assertRaisesRegex(MODULE.CorpusValidationError, "unknown=\['extra'\]"):
            MODULE.validate_corpus(self.corpus)

    def test_rejects_malformed_json(self) -> None:
        path = self.corpus / "reasoning.jsonl"
        path.write_text("{not-json}\n", encoding="utf-8")
        self.rewrite_manifest()
        with self.assertRaisesRegex(MODULE.CorpusValidationError, "invalid JSON"):
            MODULE.validate_corpus(self.corpus)


if __name__ == "__main__":
    unittest.main()
