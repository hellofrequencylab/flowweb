#!/usr/bin/env python3
"""Validate Core contract examples against the Core JSON Schemas (draft 2020-12).

Run:  python3 -I contracts-core/validate.py
Needs: pip install jsonschema referencing   (jsonschema >= 4.18)
Exit code 0 only if every valid example validates AND every invalid example is rejected.
"""
import json, sys, pathlib
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

HERE = pathlib.Path(__file__).resolve().parent
SCHEMAS = HERE / "json-schema"

def load_registry():
    reg = Registry()
    for p in sorted(SCHEMAS.glob("*.json")):
        doc = json.loads(p.read_text())
        # every schema is also meta-valid
        Draft202012Validator.check_schema(doc)
        reg = reg.with_resource(doc["$id"], Resource.from_contents(doc, default_specification=DRAFT202012))
    return reg

def main():
    reg = load_registry()
    manifest = json.loads((HERE / "examples" / "manifest.json").read_text())
    ok = bad = 0
    failures = []
    for name, schema_rel in manifest["examples"].items():
        schema = json.loads((HERE / "examples" / schema_rel).resolve().read_text())
        errs = list(Draft202012Validator(schema, registry=reg).iter_errors(json.loads((HERE / "examples" / name).read_text())))
        if errs:
            failures.append((name, errs[0].message[:160]))
        else:
            ok += 1
    rejected = 0
    for name, schema_rel in manifest["invalid"].items():
        schema = json.loads((HERE / "examples" / schema_rel).resolve().read_text())
        errs = list(Draft202012Validator(schema, registry=reg).iter_errors(json.loads((HERE / "examples-invalid" / name).read_text())))
        if errs:
            rejected += 1
        else:
            failures.append((name, "invalid example was ACCEPTED"))
    # ---- core-policy.yaml: every compiled rule is a valid policy-rule, and the matrix respects the L3 ceiling
    policy_msg = "core-policy.yaml: skipped (PyYAML not installed)"
    try:
        import yaml
        pol = yaml.safe_load((HERE / "core-policy.yaml").read_text())
        rule_schema = json.loads((SCHEMAS / "policy-rule.json").read_text())
        common = json.loads((SCHEMAS / "common.json").read_text())
        classes = set(common["$defs"]["action_class"]["enum"])
        rv = Draft202012Validator(rule_schema, registry=reg)
        n_rules = 0
        ids = set()
        for r in pol["rules"]:
            n_rules += 1
            ids.add(r["id"])
            for e in rv.iter_errors(r):
                failures.append(("core-policy.yaml rule " + r["id"], e.message[:160]))
        if len(ids) != n_rules:
            failures.append(("core-policy.yaml", "duplicate rule id"))
        rank = {t: i for i, t in enumerate(pol["tiers"])}
        ceiling = rank[pol["global"]["max_global_tier"]]
        for cls, spec in pol["autonomy_matrix"].items():
            if cls not in classes:
                failures.append(("core-policy.yaml", "unknown action class " + cls))
            for env in pol["environments"]:
                if rank[spec[env]["cap"]] > ceiling:
                    failures.append(("core-policy.yaml", "%s.%s cap exceeds global ceiling" % (cls, env)))
                if rank[spec[env]["default"]] > rank[spec[env]["cap"]]:
                    failures.append(("core-policy.yaml", "%s.%s default above cap" % (cls, env)))
        policy_msg = "core-policy.yaml: %d rules valid, %d action classes, ceiling %s" % (n_rules, len(pol["autonomy_matrix"]), pol["global"]["max_global_tier"])
    except ImportError:
        pass
    n_schemas = len(list(SCHEMAS.glob("*.json")))
    print(f"schemas meta-valid: {n_schemas}")
    print(f"valid examples accepted: {ok}/{len(manifest['examples'])}")
    print(f"invalid examples rejected: {rejected}/{len(manifest['invalid'])}")
    print(policy_msg)
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0

if __name__ == "__main__":
    sys.exit(main())
