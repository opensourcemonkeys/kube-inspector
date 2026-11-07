#!/usr/bin/env python3
"""Keep the newest releases of each update channel in the R2 bucket's dist/;
delete the rest.

    python3 scripts/release/prune_dist.py --bucket B --endpoint URL [--keep 3] [--dry-run]

The channels are the app's own (internal/business/update.go, Makefile
STABLE_VERSION): *stable* is every release without a prerelease suffix, *beta*
is every release. The newest --keep of each are kept, so at most 2 x --keep
versions stay; everything older is deleted, artifacts, .sha256 sidecars and
SHA256SUMS-<version> alike. Versions come from the repository's v* tags, which
needs a full checkout (fetch-depth: 0).

Deleting from the public bucket cannot be undone, so it is deliberately narrow:

- A file is deleted only when its name carries a known release version as a
  whole token (`-1.0.0-`, `_1.0.0_`, `-1.0.0.deb`, `-1.0.0` at the end) and that
  version is not kept. The longest version is tried first, so a 1.0.0-rc.1 file
  is never taken for 1.0.0. Anything not attributable — the bare SHA256SUMS, a
  file of an untagged version, anything unexpected — is left alone.
- Before deleting, the versions the published update manifests point at are
  checked; if one of them would be deleted, nothing is.
- No tags means nothing is attributable, so nothing is deleted.

Stdlib only; the aws CLI does the S3 calls (the R2 credentials come from the
environment, as in build.yml). Tests: test_prune_dist.py.
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")
MANIFESTS = ["https://kubeinspector.com/version.json", "https://kubeinspector.com/version-beta.json"]


def parse(v):
    m = SEMVER.match(v)
    if not m:
        return None
    major, minor, patch, pre = m.groups()
    return int(major), int(minor), int(patch), pre


def sort_key(v):
    """SemVer precedence: a release outranks its prereleases, and prerelease
    identifiers compare numerically when numeric (rc.10 > rc.2). `sort -V`
    gets both wrong, which is why this is not a shell pipeline."""
    major, minor, patch, pre = parse(v)
    if pre is None:
        return (major, minor, patch, 1, ())
    ids = tuple((0, int(i), "") if i.isdigit() else (1, 0, i) for i in pre.split("."))
    return (major, minor, patch, 0, ids)


def keep_set(versions, keep):
    valid = [v for v in versions if parse(v)]
    ranked = sorted(valid, key=sort_key, reverse=True)
    stable = [v for v in ranked if "-" not in v]
    return set(ranked[:keep]) | set(stable[:keep])


def attribute(key, versions):
    """The release a file belongs to, or None."""
    name = key.rsplit("/", 1)[-1]
    for v in sorted(versions, key=len, reverse=True):
        for m in re.finditer(re.escape(v), name):
            before = name[m.start() - 1] if m.start() > 0 else ""
            after = name[m.end()] if m.end() < len(name) else ""
            if before in ("-", "_") and after in ("-", "_", ".", ""):
                return v
    return None


def plan(versions, keys, keep):
    """-> (versions kept, keys to delete, keys left alone as unattributable)"""
    versions = [v for v in versions if parse(v)]
    kept = keep_set(versions, keep)
    delete, unattributed = [], []
    for key in keys:
        v = attribute(key, versions)
        if v is None:
            unattributed.append(key)
        elif v not in kept:
            delete.append(key)
    return kept, delete, unattributed


def tags():
    out = subprocess.run(["git", "tag", "--list", "v*"], capture_output=True, text=True, check=True).stdout
    return [t[1:] for t in out.split()]


def list_keys(bucket, endpoint, prefix):
    out = subprocess.run(
        ["aws", "s3api", "list-objects-v2", "--bucket", bucket, "--prefix", prefix,
         "--endpoint-url", endpoint, "--query", "Contents[].Key", "--output", "json"],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out) or []


def manifest_versions(urls):
    found = {}
    for url in urls:
        req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "Pragma": "no-cache",
                                                   "User-Agent": "kube-inspector-release-prune"})
        with urllib.request.urlopen(req, timeout=20) as r:
            found[url] = (json.load(r).get("version") or "").strip()
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--prefix", default="dist/")
    ap.add_argument("--keep", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.keep < 1:
        sys.exit("--keep must be at least 1")

    versions = tags()
    if not versions:
        sys.exit("no v* tags in this checkout (fetch-depth: 0?) - refusing to guess which releases are current")
    keys = list_keys(args.bucket, args.endpoint, args.prefix)
    kept, delete, unattributed = plan(versions, keys, args.keep)

    print(f"{len(keys)} objects under {args.prefix}; keeping the newest {args.keep} of each channel:")
    for v in sorted(kept, key=sort_key, reverse=True):
        print(f"  keep    {v}")
    print(f"{len(unattributed)} object(s) belong to no known release and are left alone"
          + (": " + ", ".join(sorted(unattributed)[:10]) + (" ..." if len(unattributed) > 10 else "") if unattributed else ""))
    dropped = sorted({attribute(k, versions) for k in delete}, key=sort_key, reverse=True)
    print(f"{len(delete)} object(s) of {len(dropped)} older release(s) to delete: {', '.join(dropped) or '-'}")

    # The manifests must point at kept versions. A stale CDN copy names the
    # previous release, which is still among the kept ones.
    try:
        for url, v in manifest_versions(MANIFESTS).items():
            if v and v not in kept:
                sys.exit(f"{url} points at {v}, which this run would delete - aborting, nothing deleted")
    except (OSError, ValueError) as e:
        sys.exit(f"could not read the update manifests ({e}) - aborting, nothing deleted")

    if args.dry_run or not delete:
        print("dry run - nothing deleted" if args.dry_run else "nothing to delete")
        return

    def rm(key):
        r = subprocess.run(["aws", "s3", "rm", f"s3://{args.bucket}/{key}", "--endpoint-url", args.endpoint,
                            "--only-show-errors"], capture_output=True, text=True)
        return key, r.returncode, r.stderr.strip()

    # One DeleteObject per key rather than a batched DeleteObjects: the batch call
    # needs a request checksum that R2 and the CLI's defaults have disagreed on,
    # and after the first run this is a handful of files per release.
    with ThreadPoolExecutor(max_workers=8) as pool:
        failed = [(k, err) for k, rc, err in pool.map(rm, delete) if rc != 0]
    for k, err in failed:
        print(f"::error::could not delete {k}: {err}")
    print(f"deleted {len(delete) - len(failed)} of {len(delete)} object(s)")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
