"""Tests for scripts/ocr-scanned-pdfs.py.  Run:  python -I -m unittest tests.py.test_ocr_scanned_pdfs -v
(from the repo root; not part of `npm run gate`).  The end-to-end OCR test needs Tesseract + PyMuPDF + Pillow and
is skipped when any is missing."""
import datetime
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "..", "scripts", "ocr-scanned-pdfs.py")
spec = importlib.util.spec_from_file_location("ocr_scanned_pdfs", SCRIPT)
ocr = importlib.util.module_from_spec(spec)
sys.modules["ocr_scanned_pdfs"] = ocr
spec.loader.exec_module(ocr)


class TierAndSafety(unittest.TestCase):
    def test_tier1_covers_clause_bearing_documents(self):
        for rel in [
            r"Business\55 New Plant Court\Lease Tenant 155 LLC -- 55 New Plant Court 10-2022.pdf",
            r"Business\X\Amendment to Lease.pdf",
            r"Business\Loans External\Loan Agreement.pdf",
            r"Business\X\Insurance Certificate.pdf",
            r"Business\X\SNDA and Estoppel.pdf",
            r"Business\X\PSA -- 3034 Westerville.pdf",
        ]:
            self.assertEqual(ocr.tier_of(rel), 1, rel)

    def test_other_documents_are_tier2(self):
        for rel in [r"Business\X\Flyer -- 55 New Plant Court.pdf", r"Business\X\As-Builts.pdf"]:
            self.assertEqual(ocr.tier_of(rel), 2, rel)

    def test_w9_and_taxpayer_files_are_never_ocrd(self):
        for rel in [r"Business\W9s\Acme.pdf", r"Business\X\W-9 Tenant 155 LLC.pdf", r"Business\X\w9.pdf",
                    r"Business\X\Taxpayer ID form.pdf"]:
            self.assertTrue(ocr.is_sensitive(rel), rel)

    def test_sensitive_filter_catches_real_world_w9_filenames(self):
        # Found by the adversarial review: these are how W-9s are actually downloaded/duplicated/typed.
        for rel in [r"Business\X\fw9.pdf", r"Business\X\fw9 (1).pdf", r"Business\X\Acme W-9(1).pdf",
                    r"Business\X\W9(2).pdf", r"Business\X\W 9 Acme.pdf", "Business\\X\\W–9 Acme.pdf",
                    r"Business\X\W_9 Acme.pdf", r"Business\X\w9form.pdf", r"Business\X\Acme(W9).pdf",
                    r"Business\X\[W9] Acme.pdf", r"Business\X\Acme.W9.pdf", r"Business\X\Acme W9's.pdf",
                    r"Business\X\Acme W9signed.pdf", r"Business\X\Tax payer ID.pdf",
                    r"Business\X\Tax ID Number.pdf", r"Business\X\Tax Identification Letter.pdf",
                    r"Business\X\Tax-ID.pdf", r"Business\X\FederalTaxIdentification.pdf"]:
            self.assertTrue(ocr.is_sensitive(rel), rel)

    def test_sensitive_filter_does_not_overmatch(self):
        for rel in [r"Business\X\Lease 1099 Tenant 155 LLC.pdf", r"Business\X\Window9 Report.pdf", r"Business\X\Lease.pdf",
                    r"Business\X\Lease 109 Main St.pdf", r"Business\X\W91 Report.pdf",
                    r"Business\123 W 9th St\Lease.pdf", r"Business\X\500 W 9 Mile Rd Lease.pdf",
                    r"Business\X\Syntax ID Guide.pdf", r"Business\X\Lease Tax Bill 2025.pdf",
                    r"Business\X\Tax Identifier Parcel Map.pdf"]:
            self.assertFalse(ocr.is_sensitive(rel), rel)

    def test_make_tmp_root_is_always_a_fresh_directory(self):
        d = tempfile.mkdtemp(prefix="ocrtmproot-")
        try:
            foreign = os.path.join(d, f"ocr-tmp-{os.getpid()}")  # what a PID-derived name would collide with
            os.makedirs(foreign)
            with open(os.path.join(foreign, "KEEP.txt"), "w") as fh:
                fh.write("not ours")
            made = ocr.make_tmp_root(d)
            self.assertNotEqual(os.path.abspath(made), os.path.abspath(foreign))
            self.assertEqual(os.listdir(made), [])
            self.assertTrue(os.path.exists(os.path.join(foreign, "KEEP.txt")))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_validate_manifest_rejects_stale_future_relative_and_bad_keys(self):
        now = datetime.datetime(2026, 10, 14, 12, 0, 0).astimezone()
        good = {"generatedAt": now.isoformat(), "cacheDir": os.path.abspath(os.sep + "cache"),
                "pdfs": [{"rel": "a.pdf", "key": "a" * 40}]}
        self.assertEqual(ocr.validate_manifest(good, 24, now), [])
        z = dict(good, generatedAt=(now.astimezone(datetime.timezone.utc) - datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
        self.assertEqual(ocr.validate_manifest(z, 24, now), [])  # TS toISOString() 'Z' form parses
        self.assertTrue(ocr.validate_manifest(dict(good, generatedAt=(now - datetime.timedelta(hours=30)).isoformat()), 24, now))
        self.assertTrue(ocr.validate_manifest(dict(good, generatedAt=(now + datetime.timedelta(hours=2)).isoformat()), 24, now))
        self.assertTrue(ocr.validate_manifest(dict(good, generatedAt=None), 24, now))
        self.assertTrue(ocr.validate_manifest(dict(good, cacheDir="relative/cache"), 24, now))
        self.assertTrue(ocr.validate_manifest(dict(good, pdfs=[{"rel": "a.pdf", "key": "../x"}]), 24, now))
        self.assertTrue(ocr.validate_manifest(dict(good, pdfs=[{"rel": "a.pdf", "key": "A" * 40}]), 24, now))


class Selection(unittest.TestCase):
    def test_needs_ocr_uses_average_chars_per_page(self):
        self.assertTrue(ocr.needs_ocr(12, 1))            # blank scan
        self.assertTrue(ocr.needs_ocr(400, 4))           # 100/page
        self.assertFalse(ocr.needs_ocr(3000, 4))         # healthy text layer
        self.assertFalse(ocr.needs_ocr(0, 0))            # no pages → nothing to OCR

    def test_order_jobs_tier1_first_then_small_first(self):
        entries = [
            {"rel": "a/Flyer.pdf", "size": 10},
            {"rel": "a/Lease Big.pdf", "size": 900},
            {"rel": "a/Lease Small.pdf", "size": 100},
        ]
        self.assertEqual([e["rel"] for e in ocr.order_jobs(entries, "all")],
                         ["a/Lease Small.pdf", "a/Lease Big.pdf", "a/Flyer.pdf"])
        self.assertEqual([e["rel"] for e in ocr.order_jobs(entries, "1")], ["a/Lease Small.pdf", "a/Lease Big.pdf"])
        self.assertEqual([e["rel"] for e in ocr.order_jobs(entries, "2")], ["a/Flyer.pdf"])

    def test_group_by_size_keeps_order_and_groups_equal_sizes(self):
        entries = [
            {"rel": "a/1.pdf", "size": 100},
            {"rel": "b/2.pdf", "size": 200},
            {"rel": "c/3.pdf", "size": 100},  # same size as a/1.pdf → same group, processed sequentially
        ]
        groups = ocr.group_by_size(entries)
        self.assertEqual([[e["rel"] for e in g] for g in groups], [["a/1.pdf", "c/3.pdf"], ["b/2.pdf"]])

    def test_parse_stop_at_rolls_to_next_day_when_time_has_passed(self):
        now = datetime.datetime(2026, 10, 14, 23, 0, 0)
        same_day = datetime.datetime.fromtimestamp(ocr.parse_stop_at("23:30", now))
        next_day = datetime.datetime.fromtimestamp(ocr.parse_stop_at("06:30", now))
        self.assertEqual(same_day, datetime.datetime(2026, 10, 14, 23, 30))
        self.assertEqual(next_day, datetime.datetime(2026, 10, 15, 6, 30))


class CacheWrites(unittest.TestCase):
    def test_write_atomic_leaves_no_tmp_file_and_roundtrips_utf8(self):
        d = tempfile.mkdtemp(prefix="ocrtest-")
        try:
            p = os.path.join(d, "k.txt")
            ocr.write_atomic(p, "Tenant’s option to renew")
            with open(p, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "Tenant’s option to renew")
            self.assertEqual(os.listdir(d), ["k.txt"])
        finally:
            shutil.rmtree(d, ignore_errors=True)


def _have_ocr_stack():
    try:
        import fitz  # noqa: F401
        from PIL import Image  # noqa: F401
    except ImportError:
        return False
    return os.path.exists(ocr.TESSERACT)


@unittest.skipUnless(_have_ocr_stack(), "needs Tesseract + PyMuPDF + Pillow")
class EndToEnd(unittest.TestCase):
    def _make_scanned_pdf(self, path, text):
        import fitz
        from PIL import Image, ImageDraw, ImageFont

        img = Image.new("L", (1700, 400), 255)
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("arial.ttf", 64)
        except OSError:
            font = ImageFont.load_default()
        draw.text((60, 140), text, fill=0, font=font)
        png = path + ".png"
        img.save(png)
        doc = fitz.open()
        page = doc.new_page(width=612, height=144)
        page.insert_image(page.rect, filename=png)  # image-only page: NO text layer
        doc.save(path)
        doc.close()
        os.remove(png)

    def _job(self, root, cache, rel, key, path):
        return {"rel": rel, "key": key, "path": path, "cache_dir": cache, "tmp_root": os.path.join(root, "tmp"),
                "dpi": 200, "deadline": 0.0, "min_free_gb": 0.0, "min_chars_per_page": 150}

    def test_scanned_pdf_gets_a_sidecar_and_second_run_is_skipped(self):
        root = tempfile.mkdtemp(prefix="ocre2e-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            pdf = os.path.join(root, "scan.pdf")
            self._make_scanned_pdf(pdf, "Tenant shall have an option to renew")
            job = self._job(root, cache, "Business/Lease Scan.pdf", "a" * 40, pdf)
            r1 = ocr.ocr_one(job)
            self.assertEqual(r1["status"], "ocr", r1)
            with open(os.path.join(cache, ("a" * 40) + ".txt"), encoding="utf-8") as fh:
                self.assertIn("option to renew", fh.read().lower())
            self.assertEqual(ocr.ocr_one(job)["status"], "skipped-cached")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_identical_scans_at_different_paths_are_ocrd_once(self):
        root = tempfile.mkdtemp(prefix="ocrdedup-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            a = os.path.join(root, "a.pdf")
            b = os.path.join(root, "b.pdf")
            self._make_scanned_pdf(a, "Tenant shall have an option to renew")
            shutil.copyfile(a, b)  # byte-identical duplicate at another path (e.g. Master Lease Database copy)
            ja = self._job(root, cache, "Business/X/Lease Copy A.pdf", "1" * 40, a)
            jb = self._job(root, cache, "Business/Master Lease Database/Lease Copy B.pdf", "2" * 40, b)
            results = ocr.ocr_group([ja, jb])
            self.assertEqual([r["status"] for r in results], ["ocr", "ocr-dedup"], results)
            with open(os.path.join(cache, ("1" * 40) + ".txt"), encoding="utf-8") as fa, \
                    open(os.path.join(cache, ("2" * 40) + ".txt"), encoding="utf-8") as fb:
                self.assertEqual(fa.read(), fb.read())
            self.assertEqual(len(os.listdir(os.path.join(cache, "by-hash"))), 1)
            self.assertEqual(ocr.ocr_one(jb)["status"], "skipped-cached")  # and a re-run skips both
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_cli_pool_run_dedupes_duplicates_and_skips_sensitive(self):
        import subprocess

        root = tempfile.mkdtemp(prefix="ocrcli-")
        try:
            cache = os.path.join(root, "cache")
            a, b, w9 = (os.path.join(root, n) for n in ("a.pdf", "b.pdf", "w9.pdf"))
            self._make_scanned_pdf(a, "Tenant shall have an option to renew")
            shutil.copyfile(a, b)
            shutil.copyfile(a, w9)
            size = os.path.getsize(a)
            ents = [
                {"rel": "Business/Lease A.pdf", "path": a, "key": "3" * 40, "size": size, "cached": False},
                {"rel": "Business/Master Lease Database/Lease B.pdf", "path": b, "key": "4" * 40, "size": size, "cached": False},
                {"rel": "Business/W9s/Vendor W9.pdf", "path": w9, "key": "5" * 40, "size": size, "cached": False},
            ]
            manifest = os.path.join(root, "manifest.json")
            with open(manifest, "w", encoding="utf-8") as fh:
                json.dump({"generatedAt": datetime.datetime.now().isoformat(), "cacheDir": cache, "pdfs": ents}, fh)
            p = subprocess.run([sys.executable, "-I", SCRIPT, "--manifest", manifest, "--tier", "all", "--workers", "2",
                                "--min-free-gb", "0"], capture_output=True, text=True, encoding="utf-8", errors="replace")
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertEqual(sorted(f for f in os.listdir(cache) if f.endswith(".txt")), [("3" * 40) + ".txt", ("4" * 40) + ".txt"])
            self.assertFalse(os.path.exists(os.path.join(cache, ("5" * 40) + ".txt")))  # W-9: never OCR'd (not even listed to the pool)
            self.assertIn("'ocr': 1", p.stdout)
            self.assertIn("'ocr-dedup': 1", p.stdout)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_different_scans_in_one_group_are_both_ocrd(self):
        root = tempfile.mkdtemp(prefix="ocrnodedup-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            a = os.path.join(root, "a.pdf")
            b = os.path.join(root, "b.pdf")
            self._make_scanned_pdf(a, "First lease body text")
            self._make_scanned_pdf(b, "Second lease body text")
            results = ocr.ocr_group([self._job(root, cache, "Business/Lease A.pdf", "6" * 40, a),
                                     self._job(root, cache, "Business/Lease B.pdf", "7" * 40, b)])
            self.assertEqual([r["status"] for r in results], ["ocr", "ocr"], results)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    # ---- fixes from the adversarial review (2026-10-14) -------------------------------------------------
    def test_tesseract_failure_is_never_cached_as_empty_success(self):
        root = tempfile.mkdtemp(prefix="ocrfail-")
        saved = ocr.TESSERACT
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            a = os.path.join(root, "a.pdf")
            self._make_scanned_pdf(a, "Tenant shall have an option to renew")
            ocr.TESSERACT = sys.executable  # `python.exe <png> stdout ...` exits non-zero with empty stdout
            r = ocr.ocr_one(self._job(root, cache, "Business/Lease A.pdf", "c" * 40, a))
            self.assertEqual(r["status"], "error", r)
            self.assertEqual(os.listdir(cache), [])  # no sidecar, no by-hash entry, nothing poisoned
        finally:
            ocr.TESSERACT = saved
            shutil.rmtree(root, ignore_errors=True)

    def test_page_failure_means_no_partial_sidecar(self):
        root = tempfile.mkdtemp(prefix="ocrpart-")
        saved = ocr.ocr_page
        try:
            import fitz

            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            pdf = os.path.join(root, "two.pdf")
            doc = fitz.open()
            for _ in range(2):
                doc.new_page(width=612, height=144).insert_image(fitz.Rect(0, 0, 612, 144), pixmap=fitz.Pixmap(fitz.csGRAY, fitz.IRect(0, 0, 50, 50), False))
            doc.save(pdf)
            doc.close()
            calls = {"n": 0}

            def flaky(page, png, dpi):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise RuntimeError("tesseract timeout")
                return "page text that is long enough to count as text"

            ocr.ocr_page = flaky
            r = ocr.ocr_one(self._job(root, cache, "Business/Lease Two.pdf", "f" * 40, pdf))
            self.assertEqual(r["status"], "error", r)  # 1 of 2 pages failed → do NOT cache half a lease
            self.assertEqual(os.listdir(cache), [])
        finally:
            ocr.ocr_page = saved
            shutil.rmtree(root, ignore_errors=True)

    def test_blank_scan_is_marked_skip_not_cached_as_empty_text(self):
        import fitz
        from PIL import Image

        root = tempfile.mkdtemp(prefix="ocrblank-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            png = os.path.join(root, "blank.png")
            Image.new("L", (1700, 400), 255).save(png)
            pdf = os.path.join(root, "blank.pdf")
            doc = fitz.open()
            doc.new_page(width=612, height=144).insert_image(fitz.Rect(0, 0, 612, 144), filename=png)
            doc.save(pdf)
            doc.close()
            r = ocr.ocr_one(self._job(root, cache, "Business/Lease Blank.pdf", "b" * 40, pdf))
            self.assertEqual(r["status"], "skipped-empty", r)
            self.assertEqual(os.listdir(cache), ["b" * 40 + ".skip"])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_invalid_cache_key_is_rejected_and_writes_nothing_outside_the_cache(self):
        root = tempfile.mkdtemp(prefix="ocrkey-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            pdf = os.path.join(root, "a.pdf")
            self._make_scanned_pdf(pdf, "Lease body text")
            for bad in ["..\\..\\ESCAPED", os.path.join(root, "ABS"), "short", "g" * 40, "A" * 40]:
                r = ocr.ocr_one(self._job(root, cache, "Business/Lease.pdf", bad, pdf))
                self.assertEqual(r["status"], "error", (bad, r))
            self.assertEqual(sorted(os.listdir(root)), ["a.pdf", "cache", "tmp"])  # nothing escaped
            self.assertEqual(os.listdir(cache), [])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_group_stops_writing_after_a_stop_result(self):
        root = tempfile.mkdtemp(prefix="ocrgrp-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            a = os.path.join(root, "a.pdf")
            self._make_scanned_pdf(a, "Lease body text")
            # A by-hash entry already exists for these bytes, so WITHOUT a stop guard each job would happily
            # write a de-dup sidecar (and a text-layer job a .skip marker) even though the run is over.
            os.makedirs(os.path.join(cache, "by-hash"))
            ocr.write_atomic(os.path.join(cache, "by-hash", ocr.file_sha1(a) + ".txt"), "already OCR'd text")
            # Job 0 hits its (past) deadline; job 1 has NO deadline of its own. Only the group-level stop guard
            # can stop job 1 — without it job 1 would de-dup from the by-hash entry and write a sidecar.
            jobs = []
            for i in range(2):
                j = self._job(root, cache, f"Business/Lease {i}.pdf", f"{i + 1:040x}", a)
                j["deadline"] = 1.0 if i == 0 else 0.0
                jobs.append(j)
            results = ocr.ocr_group(jobs)
            self.assertEqual([r["status"] for r in results], ["stopped", "stopped"], results)
            self.assertEqual(sorted(os.listdir(cache)), ["by-hash"])  # no sidecar / .skip written after the stop
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_empty_shared_store_entry_is_not_trusted(self):
        root = tempfile.mkdtemp(prefix="ocrempty-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(os.path.join(cache, "by-hash"))
            os.makedirs(os.path.join(root, "tmp"))
            a = os.path.join(root, "a.pdf")
            self._make_scanned_pdf(a, "Tenant shall have an option to renew")
            with open(os.path.join(cache, "by-hash", ocr.file_sha1(a) + ".txt"), "w") as fh:
                fh.write("")  # zero-length: e.g. a power loss after the rename but before the data hit disk
            r = ocr.ocr_one(self._job(root, cache, "Business/Lease.pdf", "a" * 40, a))
            self.assertEqual(r["status"], "ocr", r)  # re-OCR'd, NOT de-duped to the empty text
            with open(os.path.join(cache, "a" * 40 + ".txt"), encoding="utf-8") as fh:
                self.assertIn("option to renew", fh.read().lower())
        finally:
            shutil.rmtree(root, ignore_errors=True)

    @unittest.skipUnless(os.name == "nt", "Windows long-path handling")
    def test_paths_over_260_characters_are_readable(self):
        root = tempfile.mkdtemp(prefix="ocrlong-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            short = os.path.join(root, "a.pdf")
            self._make_scanned_pdf(short, "Tenant shall have an option to renew")
            deep = os.path.join(root, *["segment-of-a-deliberately-long-folder-name"] * 7)
            os.makedirs("\\\\?\\" + deep)
            long_pdf = os.path.join(deep, "Lease Tenant 155 LLC long path copy.pdf")
            shutil.copyfile("\\\\?\\" + short, "\\\\?\\" + long_pdf)
            self.assertGreater(len(long_pdf), 260)
            r = ocr.ocr_one(self._job(root, cache, "Business/Lease Long.pdf", "b" * 40, long_pdf))
            self.assertEqual(r["status"], "ocr", r)
        finally:
            shutil.rmtree("\\\\?\\" + root, ignore_errors=True)

    def test_cli_survives_redirected_output_with_non_cp1252_names(self):
        import subprocess

        root = tempfile.mkdtemp(prefix="ocrenc-")
        try:
            cache = os.path.join(root, "cache")
            pdf = os.path.join(root, "a.pdf")
            self._make_scanned_pdf(pdf, "Lease body text")
            ent = {"rel": "Business/Lease ✓ ◐.pdf", "path": pdf, "key": "c" * 40,
                   "size": os.path.getsize(pdf), "cached": False}
            mf = os.path.join(root, "m.json")
            with open(mf, "w", encoding="utf-8") as fh:
                json.dump({"generatedAt": datetime.datetime.now().isoformat(), "cacheDir": cache, "pdfs": [ent]}, fh)
            # `-I` ignores PYTHONUTF8/PYTHONIOENCODING, so a piped stdout is cp1252 on Windows: printing the
            # progress line for this name used to raise UnicodeEncodeError (and so would the stop-at message).
            p = subprocess.run([sys.executable, "-I", SCRIPT, "--manifest", mf, "--tier", "all", "--workers", "1",
                                "--min-free-gb", "0"], capture_output=True)
            self.assertEqual(p.returncode, 0, p.stdout[-300:] + p.stderr[-300:])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_cli_rejects_bad_manifests_and_keeps_foreign_tmp_dirs(self):
        import subprocess

        root = tempfile.mkdtemp(prefix="ocrmf-")
        try:
            cache = os.path.join(root, "cache")
            foreign = os.path.join(root, "ocr-tmp-1234")
            os.makedirs(foreign)
            with open(os.path.join(foreign, "KEEP.txt"), "w") as fh:
                fh.write("not ours")
            pdf = os.path.join(root, "a.pdf")
            self._make_scanned_pdf(pdf, "Lease body text")

            def run(manifest_obj):
                mf = os.path.join(root, "m.json")
                with open(mf, "w", encoding="utf-8") as fh:
                    json.dump(manifest_obj, fh)
                return subprocess.run([sys.executable, "-I", SCRIPT, "--manifest", mf, "--tier", "all", "--workers", "1",
                                       "--min-free-gb", "0"], capture_output=True, text=True, encoding="utf-8", errors="replace")

            fresh = datetime.datetime.now().isoformat()
            ent = {"rel": "Business/Lease.pdf", "path": pdf, "key": "a" * 40, "size": os.path.getsize(pdf), "cached": False}
            old = (datetime.datetime.now() - datetime.timedelta(days=3)).isoformat()
            self.assertNotEqual(run({"generatedAt": old, "cacheDir": cache, "pdfs": [ent]}).returncode, 0)  # stale manifest
            self.assertNotEqual(run({"generatedAt": fresh, "cacheDir": "relative\\cache", "pdfs": [ent]}).returncode, 0)
            self.assertNotEqual(run({"generatedAt": fresh, "cacheDir": cache, "pdfs": [dict(ent, key="..\\x")]}).returncode, 0)
            self.assertEqual(os.listdir(os.path.join(root)).count("ESCAPED"), 0)
            ok = run({"generatedAt": fresh, "cacheDir": cache, "pdfs": [ent]})
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            self.assertTrue(os.path.exists(os.path.join(foreign, "KEEP.txt")))  # a foreign ocr-tmp-* dir is never deleted
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_sensitive_path_is_skipped_even_if_listed(self):
        root = tempfile.mkdtemp(prefix="ocrsens-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            pdf = os.path.join(root, "scan.pdf")
            self._make_scanned_pdf(pdf, "EIN 12-3456789")
            r = ocr.ocr_one(self._job(root, cache, "Business/W9s/Vendor W-9.pdf", "8" * 40, pdf))
            self.assertEqual(r["status"], "skipped-sensitive")
            self.assertEqual(os.listdir(cache), [])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_deadline_in_the_past_writes_no_partial_sidecar(self):
        root = tempfile.mkdtemp(prefix="ocrstop-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            pdf = os.path.join(root, "scan.pdf")
            self._make_scanned_pdf(pdf, "Lease body text")
            job = self._job(root, cache, "Business/Lease.pdf", "9" * 40, pdf)
            job["deadline"] = 1.0  # long past
            self.assertEqual(ocr.ocr_one(job)["status"], "stopped")
            self.assertEqual(os.listdir(cache), [])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_low_disk_aborts_without_a_sidecar(self):
        root = tempfile.mkdtemp(prefix="ocrdisk-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            pdf = os.path.join(root, "scan.pdf")
            self._make_scanned_pdf(pdf, "Lease body text")
            job = self._job(root, cache, "Business/Lease.pdf", "d" * 40, pdf)
            job["min_free_gb"] = 1e9  # impossible → DiskLow
            self.assertEqual(ocr.ocr_one(job)["status"], "disklow")
            self.assertEqual(os.listdir(cache), [])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_text_layer_pdf_is_marked_skip_not_ocrd(self):
        import fitz

        root = tempfile.mkdtemp(prefix="ocrtext-")
        try:
            cache = os.path.join(root, "cache")
            os.makedirs(cache)
            os.makedirs(os.path.join(root, "tmp"))
            pdf = os.path.join(root, "text.pdf")
            doc = fitz.open()
            page = doc.new_page()
            for line in range(30):  # many short lines: insert_text does not wrap, so one long line would be clipped
                page.insert_text((72, 40 + line * 20), f"Line {line}: a real text layer in the PDF itself")
            doc.save(pdf)
            doc.close()
            r = ocr.ocr_one(self._job(root, cache, "Business/Lease Text.pdf", "e" * 40, pdf))
            self.assertEqual(r["status"], "skipped-textlayer")
            self.assertTrue(os.path.exists(os.path.join(cache, ("e" * 40) + ".skip")))
            self.assertFalse(os.path.exists(os.path.join(cache, ("e" * 40) + ".txt")))
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
