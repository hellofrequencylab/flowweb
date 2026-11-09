"""Fixture helper for the C0 probes, not a row probe.

Validates one JSON document (path in argv[2]) against a Core schema file name (argv[1], e.g.
work-order.json) from contracts-core/json-schema, using the same jsonschema + referencing stack as
contracts-core/validate.py. Exit 0 valid, 1 invalid (errors on stderr), 3 jsonschema not installed.
"""
import json
import pathlib
import sys

try:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012
except ImportError:
    print("python jsonschema/referencing not installed (pip install -r tooling/requirements-ci.txt)", file=sys.stderr)
    sys.exit(3)

root = pathlib.Path(__file__).resolve().parents[3]
schemas = root / "contracts-core" / "json-schema"
reg = Registry()
for p in sorted(schemas.glob("*.json")):
    doc = json.loads(p.read_text())
    reg = reg.with_resource(doc["$id"], Resource.from_contents(doc, default_specification=DRAFT202012))
schema = json.loads((schemas / sys.argv[1]).read_text())
value = json.loads(pathlib.Path(sys.argv[2]).read_text())
errors = sorted(Draft202012Validator(schema, registry=reg).iter_errors(value), key=lambda e: list(e.path))
for e in errors[:10]:
    print(f"{'/'.join(str(x) for x in e.path) or '(root)'}: {e.message}", file=sys.stderr)
sys.exit(1 if errors else 0)
