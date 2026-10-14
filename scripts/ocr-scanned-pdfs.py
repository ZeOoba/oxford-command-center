#!/usr/bin/env python3
"""Offline OCR for scanned PDFs the document index cannot read.

The indexer (server/sources/documents.ts) has no OCR engine, so image-only PDFs are indexed as
(near-)empty. This script OCRs them with Tesseract and writes one UTF-8 text sidecar per PDF into the
OCR cache; the indexer prefers a sidecar over the PDF's own text layer when it is longer.

    npx tsx scripts/list-indexable-pdfs.ts --out manifest.json --env <path-to-.env>
    python -I scripts/ocr-scanned-pdfs.py --manifest manifest.json --tier 1 --workers 4 --stop-at 06:30

Safety properties (each is tested in tests/py/test_ocr_scanned_pdfs.py):
  * Scope comes ONLY from the manifest, which is produced from the indexer's own file listing, so this
    script can never OCR a path the indexer is forbidden to read (DOCUMENTS_EXCLUDE / allowlist apply).
  * Defense in depth: paths that look like W-9 / taxpayer-ID forms are never OCR'd, whatever the manifest says.
  * The source PDFs (OneDrive) are only ever READ. Output goes to the cache dir, outside OneDrive and the repo.
  * Resumable: a PDF with a sidecar (.txt) or a text-layer-OK marker (.skip) is skipped; sidecars are written
    atomically (tmp + os.replace), and a PDF stopped mid-way writes nothing.
  * Resource guards: --workers (each Tesseract is pinned to 1 thread), --stop-at (overnight window),
    --min-free-gb (aborts when the cache drive runs low). Page images are deleted right after each page.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from multiprocessing import Pool

TESSERACT = os.environ.get("TESSERACT_EXE") or r"C:\Program Files\Tesseract-OCR\tesseract.exe"

# Tier 1 = documents whose clauses people actually ask about. Everything else is tier 2.
TIER1_RE = re.compile(
    r"lease|amend|addend|renew|extension|guarant|estoppel|snda|subordinat|loan|mortgage|promissory|deed"
    r"|insurance|polic(y|ies)|declaration|\bpsa\b|purchase",
    re.IGNORECASE,
)
# Defense in depth ONLY. The real control is the indexer's exclusion list (applied when the manifest is
# built); keep this in step with the W-9 / taxpayer patterns in `DEFAULT_EXCLUDE` (server/sources/documents.ts).
SENSITIVE_RE = re.compile(
    r"(^|[^a-z0-9])f?w[\s_–—-]?9s?(?![0-9])(?!th\b)(?!\s*mile)"
    r"|tax[\s_-]*payer[\s_-]*(?:id|profile|identification)"
    r"|(^|[^a-z])tax[\s_-]*id(?:entification)?(?![a-z])"
    r"|federal[\s_-]*tax[\s_-]*id",
    re.IGNORECASE,
)
# The manifest's cache key is a SHA-1 hex digest computed by the TS side. Anything else (path separators,
# "..", absolute paths) is rejected, because the key becomes a file name inside the cache directory.
KEY_RE = re.compile(r"[0-9a-f]{40}")

DEFAULT_MIN_CHARS_PER_PAGE = 150
DEFAULT_MAX_MANIFEST_AGE_HOURS = 24.0


class StopRun(Exception):
    """Deadline reached or disk low — stop without writing a partial sidecar."""


class DiskLow(StopRun):
    pass


def tier_of(rel: str) -> int:
    return 1 if TIER1_RE.search(rel) else 2


def is_sensitive(rel: str) -> bool:
    return bool(SENSITIVE_RE.search(rel))


def needs_ocr(chars: int, pages: int, min_chars_per_page: int = DEFAULT_MIN_CHARS_PER_PAGE) -> bool:
    """True when the PDF's own text layer is too thin to index (average chars per page below the bar)."""
    if pages <= 0:
        return False
    return (chars / pages) < min_chars_per_page


def parse_stop_at(value: str, now: datetime.datetime) -> float:
    """'HH:MM' local → epoch seconds of the NEXT occurrence of that wall-clock time."""
    hh, mm = (int(x) for x in value.split(":"))
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += datetime.timedelta(days=1)
    return target.timestamp()


def validate_manifest(manifest: dict, max_age_hours: float, now: datetime.datetime) -> list:
    """Reasons to refuse the manifest (empty list = OK). The manifest decides WHICH files get OCR'd, so it is
    only trusted when it is fresh (the exclusion list may have grown since it was built), its cache dir is
    absolute, and every cache key is a SHA-1 hex digest (the key becomes a file name inside the cache dir)."""
    problems = []
    stamp = manifest.get("generatedAt")
    try:
        built = datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
        if built.tzinfo is None:
            built = built.astimezone()  # naive → local wall-clock
        if max_age_hours > 0 and (now - built) > datetime.timedelta(hours=max_age_hours):
            problems.append(f"generatedAt {stamp} is older than {max_age_hours:g}h — regenerate it with list-indexable-pdfs.ts")
        if (built - now) > datetime.timedelta(minutes=5):  # a future date would defeat the freshness check
            problems.append(f"generatedAt {stamp} is in the future")
    except ValueError:
        problems.append(f"generatedAt missing or unparseable ({stamp!r})")
    cache_dir = manifest.get("cacheDir")
    if not isinstance(cache_dir, str) or not os.path.isabs(cache_dir):
        problems.append(f"cacheDir must be an absolute path, got {cache_dir!r}")
    bad = [e.get("rel", "?") for e in manifest.get("pdfs", []) if not KEY_RE.fullmatch(str(e.get("key", "")))]
    if bad:
        problems.append(f"{len(bad)} entries have an invalid cache key (first: {bad[0]!r})")
    return problems


def order_jobs(entries, tier: str):
    """Filter by tier selection and order: tier 1 first, then smaller files first (more done per hour)."""
    picked = []
    for e in entries:
        t = tier_of(e["rel"])
        if tier == "1" and t != 1:
            continue
        if tier == "2" and t != 2:
            continue
        picked.append((t, e["size"], e))
    picked.sort(key=lambda x: (x[0], x[1]))
    return [e for _, _, e in picked]


def group_by_size(entries):
    """Group entries of equal file size, preserving first-appearance order. A group is processed by ONE
    worker, one entry after another, so byte-identical duplicates (the same scan filed in several folders,
    e.g. a Master Lease Database copy) hit the content-hash store instead of being OCR'd concurrently."""
    groups = {}
    for e in entries:
        groups.setdefault(e["size"], []).append(e)
    return list(groups.values())


def file_sha1(path: str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def sidecar(cache_dir: str, key: str, ext: str) -> str:
    return os.path.join(cache_dir, key + ext)


def long_path(path: str) -> str:
    r"""Windows extended-length form (\\?\...) so paths over 259 characters open. No-op elsewhere / for UNC."""
    if os.name != "nt":
        return path
    full = os.path.abspath(path)
    if full.startswith("\\\\"):  # already \\?\ or a UNC share: leave it
        return full
    return "\\\\?\\" + full


def make_tmp_root(parent: str) -> str:
    """A brand-new directory under `parent` (mkdtemp, never a fixed or PID-derived name), so the end-of-run
    cleanup can only ever remove a directory THIS run created."""
    return tempfile.mkdtemp(prefix="ocr-tmp-", dir=parent)


def write_atomic(path: str, text: str) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"  # per-process, so concurrent runs/workers never share a temp file
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _check_limits(deadline: float, tmp_root: str, min_free_gb: float) -> None:
    if deadline and time.time() >= deadline:
        raise StopRun("deadline reached")
    free_gb = shutil.disk_usage(tmp_root).free / 1e9
    if free_gb < min_free_gb:
        raise DiskLow(f"free disk {free_gb:.1f} GB below {min_free_gb} GB")


def ocr_page(page, png_path: str, dpi: int) -> str:
    import fitz  # PyMuPDF (imported lazily so the pure helpers above import without it)

    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
    pix.save(png_path)
    try:
        env = dict(os.environ, OMP_THREAD_LIMIT="1")
        out = subprocess.run(
            [TESSERACT, png_path, "stdout", "-l", "eng", "--psm", "3"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, env=env,
        )
        if out.returncode != 0:  # a failing Tesseract (missing language data, crash) is NOT an empty page
            raise RuntimeError(f"tesseract exited {out.returncode}")
        return (out.stdout or "").replace("\x00", "").strip()
    finally:
        try:
            os.remove(png_path)
        except OSError:
            pass


def ocr_one(job: dict) -> dict:
    """Worker: OCR one manifest entry. Never raises — returns a status dict."""
    started = time.time()
    rel, key, path = job["rel"], job["key"], job["path"]
    cache_dir, tmp_root = job["cache_dir"], job["tmp_root"]
    res = {"rel": rel, "tier": tier_of(rel), "status": "error", "pages": 0, "chars": 0, "secs": 0.0}
    try:
        if not KEY_RE.fullmatch(key or ""):
            res["status"] = "error"  # never let a manifest-supplied key steer a write outside the cache dir
            return res
        if is_sensitive(rel):
            res["status"] = "skipped-sensitive"
            return res
        if os.path.exists(sidecar(cache_dir, key, ".txt")) or os.path.exists(sidecar(cache_dir, key, ".skip")):
            res["status"] = "skipped-cached"
            return res
        # Before ANY write (.skip marker, de-dup copy, sidecar): honor the deadline and the disk guard.
        os.makedirs(tmp_root, exist_ok=True)  # disk_usage needs an existing path
        _check_limits(job["deadline"], tmp_root, job["min_free_gb"])
        import fitz

        src = long_path(path)  # 72 in-scope PDFs have paths over 259 chars; Node reads them, Python needs \\?\
        doc = fitz.open(src)
        try:
            if doc.needs_pass:
                res["status"] = "skipped-encrypted"
                return res
            n = doc.page_count
            res["pages"] = n
            chars = sum(len(doc[i].get_text().strip()) for i in range(n))
            if not needs_ocr(chars, n, job["min_chars_per_page"]):
                write_atomic(sidecar(cache_dir, key, ".skip"), "")
                res["status"] = "skipped-textlayer"
                return res
            # Content-hash store: the same bytes at another path were already OCR'd → copy, don't re-OCR.
            store = os.path.join(cache_dir, "by-hash")
            shared = os.path.join(store, file_sha1(src) + ".txt")  # dir is created only when we write
            if os.path.exists(shared):
                with open(shared, encoding="utf-8") as fh:
                    shared_text = fh.read()
                if shared_text.strip():  # a zero-length entry (crash/power loss) is a miss, never a result
                    write_atomic(sidecar(cache_dir, key, ".txt"), shared_text)
                    res.update(status="ocr-dedup", chars=len(shared_text))
                    return res
            work = os.path.join(tmp_root, f"w{os.getpid()}")
            os.makedirs(work, exist_ok=True)
            parts, failed = [], 0
            for i in range(n):
                _check_limits(job["deadline"], tmp_root, job["min_free_gb"])
                try:
                    parts.append(ocr_page(doc[i], os.path.join(work, f"p{i}.png"), job["dpi"]))
                except Exception:
                    parts.append("")
                    failed += 1
            if failed:  # ANY failed page → cache nothing: half a lease cached "done" would never be retried
                res["status"] = "error"
                return res
            text = "\n\n".join(parts).strip()
            if not text:  # every page OCR'd cleanly but nothing readable (blank/photo scan): mark done, no empty sidecar
                write_atomic(sidecar(cache_dir, key, ".skip"), "")
                res["status"] = "skipped-empty"
                return res
            os.makedirs(store, exist_ok=True)
            write_atomic(shared, text)  # publish to the content-hash store first, then the per-path sidecar
            write_atomic(sidecar(cache_dir, key, ".txt"), text)
            res.update(status="ocr", chars=len(text))
            return res
        finally:
            doc.close()
    except DiskLow:
        res["status"] = "disklow"
    except StopRun:
        res["status"] = "stopped"
    except Exception:
        res["status"] = "error"
    finally:
        res["secs"] = round(time.time() - started, 1)
    return res


def ocr_group(jobs) -> list:
    """Worker entry point: process one same-size group sequentially (see group_by_size). Once one entry
    stops the run (deadline / low disk), the rest of the group is not started, so nothing more is written."""
    results = []
    for j in jobs:
        if results and results[-1]["status"] in ("stopped", "disklow"):
            results.append({"rel": j["rel"], "tier": tier_of(j["rel"]), "status": results[-1]["status"],
                            "pages": 0, "chars": 0, "secs": 0.0})
            continue
        results.append(ocr_one(j))
    return results


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True, help="JSON from scripts/list-indexable-pdfs.ts")
    ap.add_argument("--tier", choices=["1", "2", "all"], default="1")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--min-chars-per-page", type=int, default=DEFAULT_MIN_CHARS_PER_PAGE)
    ap.add_argument("--limit", type=int, default=0, help="stop after N PDFs processed (0 = no limit)")
    ap.add_argument("--stop-at", default="", help="HH:MM local; stop at the next occurrence (overnight window)")
    ap.add_argument("--min-free-gb", type=float, default=2.0)
    ap.add_argument("--dry-run", action="store_true", help="count what would be OCR'd; write nothing")
    ap.add_argument("--log", default="", help="JSONL progress log (default: beside the cache dir)")
    ap.add_argument("--max-manifest-age-hours", type=float, default=DEFAULT_MAX_MANIFEST_AGE_HOURS,
                    help="refuse a manifest older than this (the exclusion list may have grown since it was built)")
    args = ap.parse_args(argv)
    # `python -I` ignores PYTHONUTF8/PYTHONIOENCODING, so a redirected stdout is cp1252 on Windows and any
    # name/glyph outside it (the stop-at "◐", a "✓" in a file name) would crash the run. Never let console
    # encoding abort an OCR run: use UTF-8 and escape what cannot be encoded.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass

    with open(args.manifest, encoding="utf-8") as fh:
        manifest = json.load(fh)
    problems = validate_manifest(manifest, args.max_manifest_age_hours, datetime.datetime.now().astimezone())
    if problems:
        for p in problems:
            print(f"✗ manifest rejected: {p}", file=sys.stderr)
        return 1
    cache_dir = manifest["cacheDir"]
    entries = order_jobs(manifest["pdfs"], args.tier)
    deadline = parse_stop_at(args.stop_at, datetime.datetime.now()) if args.stop_at else 0.0
    log_path = args.log or os.path.join(os.path.dirname(cache_dir), "ocr-log.jsonl")

    todo = [e for e in entries
            if not e.get("cached")
            and not is_sensitive(e["rel"])
            and not os.path.exists(sidecar(cache_dir, e["key"], ".skip"))]
    by_tier = {1: sum(1 for e in todo if tier_of(e["rel"]) == 1), 2: sum(1 for e in todo if tier_of(e["rel"]) == 2)}
    print(f"manifest: {len(manifest['pdfs'])} PDFs | selected tier={args.tier}: {len(entries)} | to check: {len(todo)} "
          f"(tier1={by_tier[1]}, tier2={by_tier[2]}) | cache={cache_dir}")
    if args.dry_run:
        print("dry run — nothing written")
        return 0
    if args.limit:
        todo = todo[: args.limit]
    os.makedirs(cache_dir, exist_ok=True)
    # Unique, created by THIS run via mkdtemp: the cleanup below can only ever remove a directory this run made
    # (a fixed or PID-derived name could collide with a foreign directory and delete it).
    tmp_root = make_tmp_root(os.path.dirname(cache_dir))

    jobs = [dict(e, cache_dir=cache_dir, tmp_root=tmp_root, dpi=args.dpi, deadline=deadline,
                 min_free_gb=args.min_free_gb, min_chars_per_page=args.min_chars_per_page) for e in todo]
    counts, exit_code = {}, 0
    t0 = time.time()
    groups = group_by_size(jobs)  # same-size files go to one worker so duplicates dedupe instead of racing
    done = 0
    stop = False
    try:
        with Pool(args.workers) as pool, open(log_path, "a", encoding="utf-8") as log:
            for results in pool.imap_unordered(ocr_group, groups, chunksize=1):
                for r in results:
                    done += 1
                    counts[r["status"]] = counts.get(r["status"], 0) + 1
                    log.write(json.dumps(dict(r, at=datetime.datetime.now().isoformat(timespec="seconds"))) + "\n")
                    log.flush()
                    print(f"[{done}/{len(jobs)}] t{r['tier']} {r['status']:<18} {r['pages']:>3}p {r['secs']:>6}s  {r['rel']}")
                    if r["status"] == "disklow":
                        print("✗ disk low — aborting run", file=sys.stderr)
                        exit_code, stop = 4, True
                    elif deadline and time.time() >= deadline:
                        print("◐ stop-at reached — resumable: re-run to continue")
                        exit_code, stop = 3, True
                if stop:
                    pool.terminate()
                    break
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)  # the mkdtemp dir above; holds only our temp page images
    print(f"done in {time.time() - t0:.0f}s: {counts}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
