"""Lease Market Intelligence owner-screen bridge.

Screens owner names with county-parcel-screen's institutional_owners.py (read-only; never edits it).
argv[1]: path to institutional_owners.py
stdin:   JSON array of owner names (UTF-8)
stdout:  {"guardOk": bool, "types": {name: owner_type}}
owner_type: never_call | affiliated | institutional | verify | private
guardOk requires _GUARD_RAW to be a dict with a list 'never_call_patterns' (an empty list is a
valid, healthy guard) AND a truthy module-level ORA_SELF. A guard file the module could not read,
or any other structurally broken guard, yields guardOk False -- the caller must fail closed on that.
Never prints matched counterparty names or patterns.
"""
import importlib.util
import json
import sys


def main() -> None:
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    module_path = sys.argv[1]
    names = json.load(sys.stdin)
    spec = importlib.util.spec_from_file_location('institutional_owners', module_path)
    if spec is None or spec.loader is None:
        raise SystemExit('cannot load owner-screen module')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    guard_ok = (
        isinstance(getattr(mod, '_GUARD_RAW', None), dict)
        and isinstance(mod._GUARD_RAW.get('never_call_patterns'), list)
        and bool(getattr(mod, 'ORA_SELF', None))
    )
    types = {}
    for name in names:
        nc, _ = mod.ora_never_call(name)
        if nc == 'NEVER-CALL':
            owner_type = 'never_call'
        elif nc == 'ORA-SELF':
            owner_type = 'affiliated'
        else:
            tier, _ = mod.screen_owner(name)
            owner_type = 'institutional' if tier == 'EXCLUDE' else 'verify' if tier == 'VERIFY' else 'private'
        types[name] = owner_type
    json.dump({'guardOk': guard_ok, 'types': types}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
