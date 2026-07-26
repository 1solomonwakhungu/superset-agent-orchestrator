"""Versioned CallForge tool-call intermediate representation."""

from .schema import (
    IR_VERSION,
    Binding,
    CallGraph,
    CallNode,
    ToolSchema,
    TypeRef,
    ValidationIssue,
    ValueSource,
)
from .xml_bridge import from_minicpm_xml, to_minicpm_xml

__all__ = [
    "IR_VERSION",
    "Binding",
    "CallGraph",
    "CallNode",
    "ToolSchema",
    "TypeRef",
    "ValidationIssue",
    "ValueSource",
    "from_minicpm_xml",
    "to_minicpm_xml",
]
