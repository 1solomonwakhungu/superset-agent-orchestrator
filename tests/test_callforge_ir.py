import json
import math
import random
import string
import unittest

from ir import Binding, CallGraph, CallNode, ToolSchema, TypeRef, ValueSource, from_minicpm_xml, to_minicpm_xml


class CallForgeIRTests(unittest.TestCase):
    def test_json_round_trip_and_parallel_frontiers(self):
        graph = CallGraph((
            CallNode("city", "lookup", outputs={"name": TypeRef("string")}),
            CallNode("units", "preferences", outputs={"unit": TypeRef("string")}),
            CallNode("weather", "weather", (
                Binding("city", TypeRef("string"), source=ValueSource("city", "name")),
                Binding("unit", TypeRef("string"), source=ValueSource("units", "unit")),
            )),
        ))
        self.assertEqual(CallGraph.from_json(graph.to_json()), graph)
        self.assertEqual(graph.topological_order(), ("city", "units", "weather"))
        self.assertEqual(graph.parallel_frontiers(), (("city", "units"), ("weather",)))

    def test_invalid_graphs_are_constructible_and_detected(self):
        graph = CallGraph((
            CallNode("a", "one", (Binding("input", TypeRef("number"), source=ValueSource("b", "value")),), {"value": TypeRef("string")}),
            CallNode("b", "two", (Binding("input", TypeRef("string"), source=ValueSource("a", "value")),), {"value": TypeRef("string")}, repair_of="missing"),
            CallNode("c", "three", (Binding("input", TypeRef("string"), source=ValueSource("absent", "value")),)),
        ))
        codes = {issue.code for issue in graph.validate()}
        self.assertTrue({"type_mismatch", "cycle", "dangling_repair", "dangling_source"} <= codes)

    def test_tool_schema_validation(self):
        graph = CallGraph((CallNode("call", "weather", (Binding("city", TypeRef("number"), 42), Binding("format", TypeRef("number"), 1), Binding("extra", TypeRef("string"), "x")), outputs={"bad": TypeRef("string")}),))
        schema = ToolSchema(arguments={"city": TypeRef("string"), "unit": TypeRef("string"), "format": TypeRef("string")}, required=frozenset({"city", "unit"}), outputs={"temperature": TypeRef("number")})
        codes = {issue.code for issue in graph.validate({"weather": schema})}
        self.assertEqual(codes, {"argument_type_mismatch", "missing_argument", "unknown_argument", "unknown_output"})

    def test_xml_corpus_round_trips_losslessly(self):
        randomizer = random.Random(390)
        alphabet = string.ascii_letters + string.digits + " <&\n"
        for _ in range(200):
            value = "".join(randomizer.choice(alphabet) for _ in range(randomizer.randint(0, 80)))
            function = "tool" + str(randomizer.randint(1, 20))
            xml = f'<function name="{function}"><param name="value">{_escape(value)}</param></function>'
            graph = from_minicpm_xml(xml)
            rendered = to_minicpm_xml(graph)
            self.assertEqual(from_minicpm_xml(rendered), graph)
            self.assertEqual(graph.nodes[0].arguments[0].literal, value)

    def test_xml_bridge_rejects_dependency_loss(self):
        graph = CallGraph((
            CallNode("a", "source", outputs={"value": TypeRef("string")}),
            CallNode("b", "sink", (Binding("value", TypeRef("string"), source=ValueSource("a", "value")),)),
        ))
        with self.assertRaisesRegex(ValueError, "cannot losslessly encode"):
            to_minicpm_xml(graph)

    def test_invalid_bindings_and_literal_types_are_detected(self):
        graph = CallGraph((CallNode("a", "tool", (
            Binding("both", TypeRef("string"), "literal", ValueSource("a", "value")),
            Binding("neither", TypeRef("string")),
            Binding("wrong", TypeRef("string"), 42),
        ), outputs={"value": TypeRef("string")}),))
        codes = {issue.code for issue in graph.validate()}
        self.assertTrue({"invalid_binding", "literal_type_mismatch", "cycle"} <= codes)

    def test_non_parallelizable_node_gets_its_own_frontier(self):
        graph = CallGraph((CallNode("a", "one"), CallNode("b", "two", parallelizable=False), CallNode("c", "three")))
        self.assertEqual(graph.parallel_frontiers(), (("b",), ("a", "c")))

    def test_invalid_graph_cannot_be_scheduled(self):
        graph = CallGraph((CallNode("a", "one", repair_of="missing"),))
        with self.assertRaisesRegex(ValueError, "invalid call graph"):
            graph.parallel_frontiers()

    def test_annotations_must_be_booleans(self):
        graph = CallGraph.from_json(json.dumps({"version": "1.0", "nodes": [{"id": "a", "tool_id": "one", "parallelizable": "false", "optional": 0}]}))
        self.assertEqual({issue.code for issue in graph.validate()}, {"invalid_annotation"})

    def test_json_number_compatibility_and_finiteness(self):
        self.assertTrue(TypeRef("number").accepts(TypeRef("integer")))
        for value in (math.nan, math.inf, -math.inf):
            graph = CallGraph((CallNode("a", "one", (Binding("value", TypeRef("number"), value),)),))
            self.assertIn("literal_type_mismatch", {issue.code for issue in graph.validate()})

    def test_xml_rejects_nested_parameter_markup(self):
        with self.assertRaisesRegex(ValueError, "nested markup"):
            from_minicpm_xml('<function name="tool"><param name="value">a<b/>c</param></function>')

    def test_unknown_versions_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported IR version"):
            CallGraph.from_json(json.dumps({"version": "2.0", "nodes": []}))


def _escape(value):
    return value.replace("&", "&amp;").replace("<", "&lt;")


if __name__ == "__main__":
    unittest.main()
