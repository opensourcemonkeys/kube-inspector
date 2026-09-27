"""MkDocs build hooks.

Two responsibilities:

1. **Changelog timeline** — keep a single source of truth: the changelog page
   (`docs/changelog.md`) carries only an intro plus a `<!-- KI_CHANGELOG -->`
   marker, and this hook replaces that marker at build time with a timeline of
   all releases parsed from CHANGELOG.md. Each version's body is left as Markdown
   wrapped in HTML (md_in_html is enabled in mkdocs.yml), so the
   `### Added/Changed/...` bullets render with the normal theme.

2. **llms.txt / llms-full.txt** — generate the two llmstxt.org discovery files
   (`on_post_build`) so LLM search (ChatGPT, Claude, Perplexity, Google AI) can
   cheaply find and ingest the docs. `llms.txt` is a compact, link-only index of
   every page grouped by nav section; `llms-full.txt` is the entire docs corpus
   concatenated as plain Markdown. Both are derived from the resolved nav and the
   page sources, so they stay in sync with the docs automatically.
"""

import json
import os
import re
import subprocess

import markdown as _md

MARKER = "<!-- KI_CHANGELOG -->"


def _app_version(config):
    """Resolve the current app version for the header chip.

    Prefers the generated docs/version-beta.json (written by
    `make docs-downloads`), falling back to the latest git tag so a bare
    `mkdocs serve` still works.

    version-beta.json, not version.json: the chip must show the version this
    site was built from, and since S15 version.json is the *stable channel*
    pointer, which deliberately lags behind on a prerelease. Reading it here
    would stamp a beta deploy with the last stable version.
    """
    root = os.path.dirname(config["config_file_path"])
    try:
        with open(os.path.join(root, "docs", "version-beta.json"), "r", encoding="utf-8") as fh:
            ver = json.load(fh).get("version")
            if ver:
                return ver if ver.startswith("v") else "v" + ver
    except (OSError, ValueError):
        pass
    try:
        tag = subprocess.check_output(
            ["git", "describe", "--tags", "--abbrev=0"],
            cwd=root,
            stderr=subprocess.DEVNULL,
        ).decode().strip()
        if tag:
            return tag
    except (OSError, subprocess.CalledProcessError):
        pass
    return ""


def on_config(config):
    config["extra"]["app_version"] = _app_version(config)
    return config

# "## [v0.6.3-alpha] - 2026-06-27"
_VERSION_RE = re.compile(r"^##\s+\[(?P<ver>[^\]]+)\]\s*(?:-\s*(?P<date>.+))?$")
# "### Added" / "### Changed" / ...
_SECTION_RE = re.compile(r"^###\s+(?P<name>.+?)\s*$")


def _strip_unreleased(text):
    """Drop the Keep-a-Changelog `## [Unreleased]` section.

    It is a staging area for work that is not in any download yet, so it must
    never reach the public changelog: being first in the file, it would take the
    "Latest" badge and open by default with an empty body. Stripped here, at the
    single read point, so the timeline and the llms-full.txt inline of
    CHANGELOG.md agree about what "released" means.
    """
    out = []
    skipping = False
    for line in text.splitlines(keepends=True):
        m = _VERSION_RE.match(line.rstrip("\n"))
        if m:
            skipping = m.group("ver").strip().lower() == "unreleased"
        if not skipping:
            out.append(line)
    return "".join(out)


def _read_changelog(config):
    """Return the released part of CHANGELOG.md, or None if it can't be found."""
    root = os.path.dirname(config["config_file_path"])
    path = os.path.join(root, "CHANGELOG.md")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return _strip_unreleased(fh.read())
    except OSError:
        return None


def _parse_versions(text):
    """Split CHANGELOG.md into a list of {ver, date, body} dicts (newest first)."""
    versions = []
    current = None
    body_lines = []

    def flush():
        if current is not None:
            current["body"] = "\n".join(body_lines).strip()
            versions.append(current)

    for line in text.splitlines():
        m = _VERSION_RE.match(line)
        if m:
            flush()
            current = {
                "ver": m.group("ver").strip(),
                "date": (m.group("date") or "").strip(),
            }
            body_lines = []
            continue
        if current is None:
            continue
        # Drop the horizontal-rule separators between versions.
        if line.strip() == "---":
            continue
        body_lines.append(line)

    flush()
    return versions


def _summary(body):
    """A short '3 added · 1 changed' style summary from the version's sections."""
    counts = []
    name = None
    n = 0
    sections = []

    def push():
        if name is not None:
            sections.append((name, n))

    for line in body.splitlines():
        m = _SECTION_RE.match(line)
        if m:
            push()
            name = m.group("name")
            n = 0
            continue
        if name is not None and line.strip().startswith("- "):
            n += 1
    push()

    for name, n in sections:
        if n:
            counts.append(f"{n} {name.lower()}")
    return " · ".join(counts)


def _render_body(body):
    """Render a version's Markdown body to HTML (own converter, no md_in_html)."""
    return _md.markdown(body, extensions=["extra"])


def _build_timeline(versions):
    out = ['<div class="ki-cl-timeline">']
    for i, v in enumerate(versions):
        is_latest = i == 0
        open_cls = " is-open" if is_latest else ""
        badge = '<span class="ki-cl-badge">Latest</span>' if is_latest else ""
        summary = _summary(v["body"])
        summary_html = (
            f'<span class="ki-cl-summary">{summary}</span>' if summary else ""
        )
        date_html = (
            f'<span class="ki-cl-date">{v["date"]}</span>' if v["date"] else ""
        )
        out.append(f'<section class="ki-cl-item ki-reveal{open_cls}" data-cl-index="{i}">')
        out.append('<span class="ki-cl-node" aria-hidden="true"></span>')
        out.append(
            f'<button type="button" class="ki-cl-head" '
            f'aria-expanded="{"true" if is_latest else "false"}">'
            f'<span class="ki-cl-head-top">'
            f'<span class="ki-cl-ver">{v["ver"]}</span>{badge}'
            f'<span class="ki-cl-chevron" aria-hidden="true"></span>'
            f"</span>"
            f'<span class="ki-cl-head-meta">{date_html}{summary_html}</span>'
            f"</button>"
        )
        out.append('<div class="ki-cl-body">')
        out.append(f'<div class="ki-cl-body-inner">{_render_body(v["body"])}</div>')
        out.append("</div>")
        out.append("</section>")
    out.append("</div>")
    return "\n".join(out)


def on_page_markdown(markdown, page, config, files):
    if page.file.src_uri != "changelog.md":
        return markdown
    if MARKER not in markdown:
        return markdown

    text = _read_changelog(config)
    if not text:
        # Graceful fallback: leave a note instead of an empty marker.
        return markdown.replace(
            MARKER, "_Changelog could not be loaded at build time._"
        )

    versions = _parse_versions(text)
    if not versions:
        return markdown.replace(MARKER, "_No releases found._")

    return markdown.replace(MARKER, _build_timeline(versions))


# ===========================================================================
# llms.txt / llms-full.txt  (https://llmstxt.org)
# ===========================================================================

# One-line pitch reused at the top of both files.
_LLMS_INTRO = (
    "Kube Inspector is a free visual desktop client for managing "
    "Kubernetes clusters on Windows, macOS, and Linux. Browse, inspect, edit "
    "YAML for, and delete every core Kubernetes resource; stream logs, exec into "
    "pods, scan images for vulnerabilities, and visualize RBAC — across multiple "
    "clusters at once. It also ships a webview-free terminal UI (kube-inspector-cli)."
)

# Captured from on_nav so on_post_build can emit pages in nav order/grouping.
_NAV = None


def on_nav(nav, config, files):
    global _NAV
    _NAV = nav
    return nav


_FRONTMATTER_RE = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)


def _strip_frontmatter(text):
    """Remove a leading YAML front-matter block, if present."""
    return _FRONTMATTER_RE.sub("", text, count=1)


def _page_source(page, config):
    """Return a page's Markdown body (front matter stripped, changelog expanded)."""
    try:
        with open(page.file.abs_src_path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return ""
    text = _strip_frontmatter(text)
    # The changelog body is a build-time marker — inline the raw CHANGELOG.md so
    # llms-full.txt carries the real release notes as plain Markdown.
    if MARKER in text:
        changelog = _read_changelog(config)
        text = text.replace(MARKER, changelog.strip() if changelog else "")
    return text.strip()


def _first_paragraph(md):
    """Best-effort one-line summary: first prose paragraph of a Markdown body."""
    for raw in md.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Skip structural / non-prose lines.
        if line.startswith(("#", "<", ">", "!!!", "???", "|", "-", "*", "[", "```", ":")):
            continue
        # Collapse inline emphasis markers and whitespace.
        line = re.sub(r"[*_`]", "", line)
        line = re.sub(r"\s+", " ", line).strip()
        if len(line) > 200:
            line = line[:197].rstrip() + "..."
        return line
    return ""


def _abs_url(config, page):
    base = (config.get("site_url") or "").rstrip("/")
    url = page.abs_url or "/"
    return base + url


def _ordered_pages():
    """Walk the captured nav → list of (section_title, page) in document order."""
    ordered = []

    def walk(items, parent):
        for item in items:
            if getattr(item, "is_section", False):
                walk(item.children, item.title)
            elif getattr(item, "is_page", False) and item.file.is_documentation_page():
                ordered.append((parent, item))

    if _NAV is not None:
        walk(_NAV.items, None)
    return ordered


def _page_description(page, config):
    """Prefer the page's `description:` front matter, else its first paragraph."""
    desc = (page.meta or {}).get("description")
    if desc:
        return re.sub(r"\s+", " ", str(desc)).strip()
    return _first_paragraph(_page_source(page, config))


def _write_llms_txt(config, ordered):
    """Compact, link-only index grouped by nav section (the llms.txt spec)."""
    base = (config.get("site_url") or "").rstrip("/")
    lines = [
        "# Kube Inspector",
        "",
        f"> {config.get('site_description', '').strip()}",
        "",
        _LLMS_INTRO,
        "",
    ]

    def bullet(page):
        title = page.title or page.file.src_uri
        desc = _page_description(page, config)
        suffix = f": {desc}" if desc else ""
        return f"- [{title}]({_abs_url(config, page)}){suffix}"

    # Top-level (parent-less) pages are scattered through the nav order; collect
    # them under one leading "Overview" heading instead of repeating it.
    top_level = [p for parent, p in ordered if not parent]
    if top_level:
        lines.append("## Overview")
        lines.append("")
        lines.extend(bullet(p) for p in top_level)
        lines.append("")

    current = None
    for section, page in ordered:
        if not section:
            continue
        if section != current:
            lines.append(f"## {section}")
            lines.append("")
            current = section
        lines.append(bullet(page))
    lines.append("")

    lines.append("## Full text")
    lines.append("")
    lines.append(
        f"- [Complete documentation]({base}/llms-full.txt): "
        "every page above concatenated as a single Markdown file."
    )
    lines.append("")

    with open(os.path.join(config["site_dir"], "llms.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def _write_llms_full_txt(config, ordered):
    """The entire docs corpus as one plain-Markdown file."""
    base = (config.get("site_url") or "").rstrip("/")
    parts = [
        "# Kube Inspector — Full Documentation",
        "",
        f"> {config.get('site_description', '').strip()}",
        "",
        _LLMS_INTRO,
        "",
        f"Source: {base or 'https://kubeinspector.com'}",
        "",
    ]
    for _, page in ordered:
        body = _page_source(page, config)
        if not body:
            continue
        title = page.title or page.file.src_uri
        parts.append("---")
        parts.append("")
        parts.append(f"# {title}")
        parts.append("")
        parts.append(f"URL: {_abs_url(config, page)}")
        parts.append("")
        parts.append(body)
        parts.append("")

    with open(os.path.join(config["site_dir"], "llms-full.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))


def on_post_build(config):
    ordered = _ordered_pages()
    if not ordered:
        return
    _write_llms_txt(config, ordered)
    _write_llms_full_txt(config, ordered)
