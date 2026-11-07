#!/usr/bin/env python3
"""python3 -m unittest discover -s scripts/release   (stdlib only, no network)"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prune_dist as p  # noqa: E402

# The real tag history up to 1.0.0-rc.1, plus what is expected later.
TAGS = [
    "0.1.0-rc", "0.8.0-alpha", "0.8.1-alpha", "0.15.0-alpha", "0.16.0-beta.1",
    "0.16.1-beta", "0.19.0-beta", "0.20.0-beta", "0.20.1-beta", "0.21.0-beta",
    "1.0.0-rc.1",
]


def artifacts(v):
    names = [
        f"kube-inspector-{v}-linux-amd64.deb", f"kube-inspector-{v}-linux-x86_64.rpm",
        f"kube-inspector-{v}-windows-amd64.exe", f"kube-inspector-{v}-macos-arm64.dmg",
        f"kube-inspector-cli-{v}-linux-amd64.tar.gz", f"kube-inspector-cli-{v}-macos-universal.tar.gz",
    ]
    return [f"dist/{n}" for n in names] + [f"dist/{n}.sha256" for n in names] + [f"dist/SHA256SUMS-{v}"]


class Ordering(unittest.TestCase):
    def test_semver_precedence(self):
        ranked = sorted(["1.0.0", "1.0.0-rc.1", "1.0.0-rc.2", "0.21.0-beta", "1.0.0-beta",
                         "1.0.0-rc.10", "1.0.1", "0.16.0-beta.1"], key=p.sort_key)
        self.assertEqual(ranked, ["0.16.0-beta.1", "0.21.0-beta", "1.0.0-beta", "1.0.0-rc.1",
                                  "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0", "1.0.1"])

    def test_invalid_versions_are_ignored(self):
        self.assertIsNone(p.parse("1.0"))
        self.assertIsNone(p.parse("toolbox-v1.0.0"))


class Keep(unittest.TestCase):
    def test_today_only_prereleases_exist(self):
        # beta = every release, stable = none yet.
        self.assertEqual(p.keep_set(TAGS, 3), {"1.0.0-rc.1", "0.21.0-beta", "0.20.1-beta"})

    def test_after_stable_releases(self):
        tags = TAGS + ["1.0.0", "1.0.1", "1.1.0-rc.1", "1.1.0-rc.2"]
        # beta channel: 1.1.0-rc.2, 1.1.0-rc.1, 1.0.1 · stable: 1.0.1, 1.0.0
        self.assertEqual(p.keep_set(tags, 3), {"1.1.0-rc.2", "1.1.0-rc.1", "1.0.1", "1.0.0"})

    def test_stable_keeps_its_own_three_even_behind_many_prereleases(self):
        tags = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "2.0.0-rc.1", "2.0.0-rc.2", "2.0.0-rc.3"]
        self.assertEqual(p.keep_set(tags, 3),
                         {"2.0.0-rc.3", "2.0.0-rc.2", "2.0.0-rc.1", "1.3.0", "1.2.0", "1.1.0"})


class Attribute(unittest.TestCase):
    def test_rc_files_are_not_taken_for_the_release(self):
        vs = ["1.0.0", "1.0.0-rc.1"]
        self.assertEqual(p.attribute("dist/kube-inspector-1.0.0-rc.1-linux-amd64.deb", vs), "1.0.0-rc.1")
        self.assertEqual(p.attribute("dist/kube-inspector-1.0.0-linux-amd64.deb", vs), "1.0.0")
        self.assertEqual(p.attribute("dist/SHA256SUMS-1.0.0-rc.1", vs), "1.0.0-rc.1")
        self.assertEqual(p.attribute("dist/SHA256SUMS-1.0.0", vs), "1.0.0")

    def test_a_version_inside_another_number_does_not_match(self):
        self.assertIsNone(p.attribute("dist/kube-inspector-10.1.0-linux-amd64.deb", ["0.1.0"]))

    def test_unknown_files_are_not_attributed(self):
        for key in ["dist/SHA256SUMS", "dist/README.txt", "dist/kube-inspector-9.9.9-linux-amd64.deb"]:
            self.assertIsNone(p.attribute(key, TAGS), key)

    def test_old_names_still_match_by_version(self):
        self.assertEqual(p.attribute("dist/kube-ins_0.8.1-alpha_amd64.deb", TAGS), "0.8.1-alpha")


class Plan(unittest.TestCase):
    def test_deletes_only_attributed_files_of_dropped_versions(self):
        keys = [k for v in TAGS for k in artifacts(v)] + ["dist/SHA256SUMS", "dist/notes.txt"]
        keep, delete, unattributed = p.plan(TAGS, keys, 3)
        self.assertEqual(keep, {"1.0.0-rc.1", "0.21.0-beta", "0.20.1-beta"})
        self.assertEqual(sorted(unattributed), ["dist/SHA256SUMS", "dist/notes.txt"])
        for v in keep:
            self.assertFalse(set(artifacts(v)) & set(delete), v)
        for v in set(TAGS) - keep:
            self.assertTrue(set(artifacts(v)) <= set(delete), v)

    def test_no_tags_deletes_nothing(self):
        keys = [k for v in TAGS for k in artifacts(v)]
        keep, delete, unattributed = p.plan([], keys, 3)
        self.assertEqual((keep, delete), (set(), []))
        self.assertEqual(len(unattributed), len(keys))


if __name__ == "__main__":
    unittest.main()
