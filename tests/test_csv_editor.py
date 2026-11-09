import codecs
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer
from support import NODE_DIR, load_node

spec = importlib.util.spec_from_file_location("editor_under_test", NODE_DIR / "nodes/csv_editor.py")
editor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editor)
TEST_TEMP = Path(os.environ.get("CSV_PICKER_TEST_TMP", NODE_DIR / ".test-tmp"))
TEST_TEMP.mkdir(parents=True, exist_ok=True)


class EditorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def source(self, raw, filename="test.csv"):
        path = self.root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        return editor.read_document(self.root, filename)

    def save(self, doc, rows, **kwargs):
        return editor.save_document(self.root, doc["filename"], rows, doc["revision"], **kwargs)

    def test_duplicate_labels_extra_columns_blank_rows_and_multiline(self):
        raw = codecs.BOM_UTF8 + '标签,"first, value",extra\r\n标签,"second\r\nline",末列\r\n\r\n'.encode()
        doc = self.source(raw)
        self.assertEqual(doc["rows"], [["标签", "first, value", "extra"], ["标签", "second\r\nline", "末列"], []])
        rows = [row[:] for row in doc["rows"]]
        rows[0][1] = '中文, "quoted"\nnew line'
        result = self.save(doc, rows)
        self.assertEqual(result["rows"], rows)
        self.assertTrue((self.root / "test.csv").read_bytes().startswith(codecs.BOM_UTF8))
        self.assertEqual((self.root / result["backup"]).read_bytes(), raw)
        self.assertEqual(result["newline"], "\r\n")

    def test_no_change_preserves_exact_bytes(self):
        raw = b'"a",b\r\n\r\n'
        doc = self.source(raw)
        result = self.save(doc, doc["rows"])
        self.assertFalse(result["changed"])
        self.assertIsNone(result["backup"])
        self.assertEqual((self.root / "test.csv").read_bytes(), raw)

    def test_single_column_and_no_final_newline(self):
        doc = self.source("单列一\n单列二".encode())
        rows = [["单列一"], ["单列二修改"], ["第三条"]]
        result = self.save(doc, rows)
        self.assertEqual(result["rows"], rows)
        self.assertFalse((self.root / "test.csv").read_bytes().endswith(b"\n"))

    def test_gb18030_encoding_preserved(self):
        doc = self.source("名称,提示词\r\n另一条,内容\r\n".encode("gb18030"))
        rows = [["名称", "更新内容"], ["另一条", "内容"]]
        result = self.save(doc, rows)
        self.assertEqual(result["encoding"], "gb18030")
        self.assertEqual(result["rows"], rows)
        self.assertIn("更新内容", (self.root / "test.csv").read_bytes().decode("gb18030"))

    def test_empty_file_and_delete_all(self):
        doc = self.source(b"")
        self.assertEqual(doc["rows"], [])
        result = self.save(doc, [["名称", "提示词"]])
        result = self.save(result, [])
        self.assertEqual(result["rows"], [])

    def test_spaces_delimiters_quotes_and_empty_cells(self):
        for delimiter in (",", ";", "\t", "|"):
            with self.subTest(delimiter=delimiter):
                raw = f'one{delimiter}  spaced\ntwo{delimiter}  text\n'.encode()
                doc = self.source(raw)
                self.assertEqual(doc["rows"][0][1], "  spaced")
                rows = [["one", 'say "hello"'], ["two", ""], []]
                result = self.save(doc, rows)
                self.assertEqual(result["rows"], rows)
                self.assertEqual(result["delimiter"], delimiter)

    def test_conflicting_revision_does_not_overwrite(self):
        doc = self.source(b"one,old\n")
        (self.root / "test.csv").write_bytes(b"one,new\n")
        with self.assertRaises(editor.CsvEditError) as error:
            self.save(doc, [["one", "stale"]])
        self.assertEqual(error.exception.status, 409)
        self.assertEqual((self.root / "test.csv").read_bytes(), b"one,new\n")
        copy = self.save(doc, [["one", "my draft"]], save_as="draft.csv")
        self.assertEqual(copy["rows"], [["one", "my draft"]])
        self.assertEqual((self.root / "test.csv").read_bytes(), b"one,new\n")

    def test_save_as_keeps_source_and_refuses_existing_target(self):
        doc = self.source(b"one,old\n", "nested/test.csv")
        result = self.save(doc, [["one", "copy"]], save_as="nested/copy.csv")
        self.assertEqual(result["filename"], "nested/copy.csv")
        self.assertEqual((self.root / "nested/test.csv").read_bytes(), b"one,old\n")
        with self.assertRaises(editor.CsvEditError):
            self.save(doc, [["one", "overwrite"]], save_as="nested/copy.csv")
        with self.assertRaises(editor.CsvEditError):
            self.save(doc, [["one", "overwrite"]], save_as="nested/test.csv")
        self.assertEqual((self.root / "nested/copy.csv").read_text(), "one,copy\n")

    def test_paths_and_payloads(self):
        doc = self.source(b"one,two\n")
        for filename in ("../escape.csv", "/absolute.csv", "C:/escape.csv", ".csv-editor-backups/a.csv", "file.txt", "nested/../../a.csv"):
            with self.subTest(filename=filename), self.assertRaises(editor.CsvEditError):
                editor.read_document(self.root, filename)
        for rows in (None, {}, [[123]], ["bad"]):
            with self.subTest(rows=rows), self.assertRaises(editor.CsvEditError):
                self.save(doc, rows)

    def test_real_csv_corpus_roundtrip_on_copies(self):
        corpus = Path(os.environ.get("CSV_PICKER_CORPUS_DIR", NODE_DIR / "examples"))
        sources = list(corpus.rglob("*.csv"))
        self.assertTrue(sources)
        for index, path in enumerate(sources):
            with self.subTest(file=path.name):
                raw = path.read_bytes()
                doc = self.source(raw, f"corpus/{index}.csv")
                same = self.save(doc, doc["rows"])
                self.assertFalse(same["changed"])
                self.assertEqual((self.root / doc["filename"]).read_bytes(), raw)
                rows = [row[:] for row in doc["rows"]]
                if rows:
                    first = next((row for row in rows if row), None)
                    if first is not None:
                        first[0] += "测试"
                        result = self.save(doc, rows)
                        self.assertEqual(result["rows"], rows)


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=TEST_TEMP)
        self.root = Path(self.temp.name)
        (self.root / "csv").mkdir()
        self.source = self.root / "csv/demo.csv"
        self.source.write_text("label,old\nother,second\n", encoding="utf-8")
        self.node, app = load_node(self.root)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    async def test_read_save_preview_execution_and_cache_invalidation(self):
        value = {"type": "CsvRowWidget", "file": "demo.csv", "key": "label", "join_comma": False}
        inputs = {"seed": 0, "csv_1": value}
        picker = self.node.CSV_MultiLangPromptPicker()
        self.assertEqual(picker.run(**inputs)[0], "old")
        before = picker.IS_CHANGED(**inputs)
        doc = await (await self.client.get("/CSV/csv_prompt_edit?filename=demo.csv")).json()
        response = await self.client.post("/CSV/csv_prompt_save", json={**doc, "rows": [["label", "updated"], ["other", "second"]]})
        self.assertEqual(response.status, 200)
        saved = await response.json()
        self.assertTrue(saved["backup"])
        preview = await (await self.client.get("/CSV/csv_prompt_read?filename=demo.csv")).json()
        self.assertEqual(preview["map"]["label"], "updated")
        self.assertEqual(picker.run(**inputs)[0], "updated")
        self.assertNotEqual(picker.IS_CHANGED(**inputs), before)
        stale = await self.client.post("/CSV/csv_prompt_save", json={**doc, "rows": [["label", "stale"]]})
        self.assertEqual(stale.status, 409)

    async def test_invalid_requests_and_missing_file(self):
        response = await self.client.get("/CSV/csv_prompt_edit?filename=../outside.csv")
        self.assertEqual(response.status, 400)
        response = await self.client.get("/CSV/csv_prompt_edit?filename=missing.csv")
        self.assertEqual(response.status, 404)
        for body in ([], {"filename": "demo.csv"}):
            response = await self.client.post("/CSV/csv_prompt_save", json=body)
            self.assertEqual(response.status, 400)
        response = await self.client.post("/CSV/csv_prompt_save", data="{", headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)


if __name__ == "__main__":
    unittest.main()
