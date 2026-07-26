import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "audit_checkpoint.py"
SPEC = importlib.util.spec_from_file_location("audit_checkpoint", SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class AuditCheckpointTests(unittest.TestCase):
    def test_inventory_uses_shapes_and_offsets(self):
        rows = audit.inventory({"weight": {"dtype": "BF16", "shape": [2, 3], "data_offsets": [0, 12]}})
        self.assertEqual(rows[0]["elements"], 6)
        self.assertEqual(rows[0]["byte_size"], 12)

    def test_inventory_rejects_inconsistent_header(self):
        with self.assertRaisesRegex(ValueError, "expected 12"):
            audit.inventory({"weight": {"dtype": "BF16", "shape": [2, 3], "data_offsets": [0, 10]}})

    def test_tool_fixture_round_trips_name_and_argument(self):
        rendered = audit.render_tool_fixture()
        self.assertIn('<function name="weather">', rendered)
        self.assertIn('<param name="city">Nairobi</param>', rendered)


if __name__ == "__main__":
    unittest.main()
