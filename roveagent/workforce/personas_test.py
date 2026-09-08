"""Executive personas map to the single RoveAgent runtime employees."""
from __future__ import annotations

import unittest

from roveagent.workforce.employees import find_employee
from roveagent.workforce.personas import PERSONA_ALIASES, persona_for


class PersonasTest(unittest.TestCase):
    def test_persona_aliases_map_to_employees(self) -> None:
        self.assertEqual(find_employee("ceo-insight").key, "ceo")
        self.assertEqual(find_employee("coo").key, "operations")
        self.assertEqual(find_employee("cmo").key, "marketing")
        self.assertEqual(find_employee("cto").key, "devops")
        # 旧 employee key 仍可直接使用
        self.assertEqual(find_employee("ceo").key, "ceo")
        self.assertIsNone(find_employee("nope"))

    def test_persona_metadata(self) -> None:
        cmo = persona_for("cmo")
        self.assertIsNotNone(cmo)
        self.assertEqual(cmo["employee_key"], "marketing")
        self.assertIn("customer growth", str(cmo["focus"]))
        cto = persona_for("cto")
        self.assertIn("system health", str(cto["focus"]))
        self.assertIn("cto", PERSONA_ALIASES)


if __name__ == "__main__":
    unittest.main()
