"""Inspect the actual rendered gate without importing the full app/database."""
import ast
from pathlib import Path
import unittest

class Node:
    def __init__(self, kind, children, props):
        self.kind, self.children, self.props = kind, children, props
class FakeRx:
    Component = Node
    def __getattr__(self, name):
        if name == 'el': return self
        return lambda *children, **props: Node(name, children, props)

class HydrationLoadingTests(unittest.TestCase):
    def test_gate_is_visible_before_hydration_with_bounded_local_retry(self):
        path=Path(__file__).parents[1]/'uni_app/uni_app.py'
        tree=ast.parse(path.read_text())
        fn=next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name=='_app_shell_loading_gate')
        scope={'rx':FakeRx()}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),str(path),'exec'),scope)
        node=scope['_app_shell_loading_gate']()
        html=next(c.children[0] for c in node.children if isinstance(c,Node) and c.kind=='html')
        self.assertIn('Connecting to AlexStudies…',html)
        self.assertIn('Still connecting…',html)
        self.assertIn('15s forwards',html)
        self.assertIn('onclick="window.location.reload()"',html)
        self.assertIn('>Retry</button>',html)
        self.assertIn('aria-live="polite"',html)
        self.assertNotIn('localStorage',html)
        self.assertNotIn('fetch(',html)
        self.assertEqual(node.props['position'],'fixed')
