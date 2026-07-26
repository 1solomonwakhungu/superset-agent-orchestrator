"""Canonical MiniCPM5/SGLang XML tool-call bridge."""

from __future__ import annotations

from xml.etree import ElementTree

from .schema import UNSET, Binding, CallGraph, CallNode, TypeRef


def from_minicpm_xml(xml: str) -> CallGraph:
    wrapped = ElementTree.fromstring(f"<calls>{xml}</calls>")
    nodes: list[CallNode] = []
    for index, function in enumerate(wrapped):
        if function.tag != "function" or not function.get("name"):
            raise ValueError("tool calls must be <function> elements with a name")
        arguments = []
        for param in function:
            if param.tag != "param" or not param.get("name"):
                raise ValueError("function children must be <param> elements with a name")
            arguments.append(Binding(param.get("name", ""), TypeRef("string"), param.text or ""))
        nodes.append(CallNode(id=f"call-{index + 1}", tool_id=function.get("name", ""), arguments=tuple(arguments)))
    return CallGraph(tuple(nodes))


def to_minicpm_xml(graph: CallGraph) -> str:
    if graph.validate():
        raise ValueError("cannot serialize an invalid call graph")
    functions = []
    for node in graph.nodes:
        function = ElementTree.Element("function", {"name": node.tool_id})
        for binding in node.arguments:
            if binding.source is not None:
                raise ValueError("MiniCPM XML cannot losslessly encode dependency bindings")
            if binding.literal is UNSET or not isinstance(binding.literal, str):
                raise ValueError("MiniCPM XML can only losslessly encode string literals")
            param = ElementTree.SubElement(function, "param", {"name": binding.argument})
            param.text = binding.literal
        functions.append(ElementTree.tostring(function, encoding="unicode", short_empty_elements=False))
    return "".join(functions)
