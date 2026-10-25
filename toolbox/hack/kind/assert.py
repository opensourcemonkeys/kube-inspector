#!/usr/bin/env python3
"""Assertions for hack/kind/e2e.sh. Polls the API until every check passes or
the deadline expires, then prints what failed.

usage: assert.py <base-url> <api-token> scenario1|scenario2
"""
import json
import sys
import time
import urllib.request

BASE, TOKEN, SCENARIO = sys.argv[1], sys.argv[2], sys.argv[3]
DEADLINE = time.time() + 150


def get(path):
    req = urllib.request.Request(BASE + "/api/v1/" + path, headers={"X-Toolbox-Token": TOKEN})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def changes():
    return get("changes?namespace=e2e&since=1h&limit=500")["items"]


def find(items, kind, name, verb):
    return [c for c in items if c["kind"] == kind and c["name"] == name and c["verb"] == verb]


def check_scenario1():
    items = changes()
    errs = []

    def expect(kind, name, verb, user, attribution=None, path=None, need_ip=True):
        rows = find(items, kind, name, verb)
        if path:
            rows = [c for c in rows if any(p == path or p.startswith(path + "/") for p in c.get("changedPaths", []))]
        if not rows:
            errs.append(f"no {verb} of {kind}/{name}" + (f" touching {path}" if path else ""))
            return None
        c = rows[-1]
        a = c.get("actor", {})
        if a.get("username") != user:
            errs.append(f"{verb} {kind}/{name}: user={a.get('username')!r} want {user!r} (via {c['attribution']})")
        if attribution and c["attribution"] != attribution:
            errs.append(f"{verb} {kind}/{name}: attribution={c['attribution']} want {attribution}")
        if need_ip and not a.get("sourceIPs"):
            errs.append(f"{verb} {kind}/{name}: no source IPs")
        if need_ip and "kubectl" not in a.get("userAgent", ""):
            errs.append(f"{verb} {kind}/{name}: user agent {a.get('userAgent')!r}")
        return c

    expect("ConfigMap", "app-config", "create", "alice", "audit")
    expect("ConfigMap", "app-config", "update", "alice", "audit", path="/data/a")
    expect("ConfigMap", "app-config", "delete", "alice", "audit")
    expect("Deployment", "web", "create", "bob", "audit")
    expect("Deployment", "web", "update", "bob", "audit", path="/spec/replicas")
    s = expect("Secret", "s1", "update", "alice", "audit", path="/data/pw")

    if s:
        full = json.dumps(get("changes/" + s["eventId"]))
        for leak in ("hunter2", "hunter3", "aHVudGVyMg==", "aHVudGVyMw=="):
            if leak in full:
                errs.append(f"secret value {leak!r} stored")

    # The controller's own writes are attributed to it, not to bob.
    rs = [c for c in items if c["kind"] == "ReplicaSet" and c["verb"] == "create"]
    if not rs:
        errs.append("no ReplicaSet create recorded")
    elif not rs[-1]["actor"].get("username", "").startswith("system:serviceaccount:kube-system:"):
        errs.append(f"ReplicaSet create attributed to {rs[-1]['actor'].get('username')!r}")

    # The scheduler binds pods through the pods/binding subresource.
    bound = [c for c in items if c["kind"] == "Pod" and c["verb"] == "update"
             and "/spec/nodeName" in c.get("changedPaths", [])]
    if not bound:
        errs.append("no pod binding recorded")
    elif not any(c["actor"].get("username") == "system:kube-scheduler" for c in bound):
        errs.append(f"pod binding attributed to {[c['actor'].get('username') for c in bound]}")

    attempts = get("attempts?namespace=e2e&since=1h")["items"]
    if not any(a["username"] == "mallory" and a["responseCode"] == 403 for a in attempts):
        errs.append("mallory's forbidden delete not listed in attempts")

    users = {u["username"] for u in get("users?since=1h")["items"]}
    for u in ("alice", "bob"):
        if u not in users:
            errs.append(f"{u} missing from /users")
    return errs


def check_scenario2():
    items = changes()
    errs = []
    for verb in ("create", "update"):
        rows = find(items, "ConfigMap", "only-admission", verb)
        if not rows:
            errs.append(f"no {verb} of only-admission")
            continue
        c = rows[-1]
        if c["actor"].get("username") != "carol" or c["attribution"] != "admission":
            errs.append(f"{verb} only-admission: user={c['actor'].get('username')!r} via {c['attribution']}")
        if c["actor"].get("sourceIPs"):
            errs.append(f"{verb} only-admission: source IPs without audit?")
    return errs


check = {"scenario1": check_scenario1, "scenario2": check_scenario2}[SCENARIO]
errs = ["not run"]
while time.time() < DEADLINE:
    try:
        errs = check()
    except Exception as e:  # API not reachable yet
        errs = [f"request failed: {e}"]
    if not errs:
        print(f"{SCENARIO}: all checks passed")
        sys.exit(0)
    time.sleep(5)

print(f"{SCENARIO}: FAILED")
for e in errs:
    print("  -", e)
sys.exit(1)
