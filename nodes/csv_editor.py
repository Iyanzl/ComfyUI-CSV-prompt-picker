"""Lossless CSV row editing, independent of the ComfyUI runtime."""

import codecs
import csv
import hashlib
import io
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


_EDIT_LOCK = threading.RLock()
MAX_BYTES = 8 * 1024 * 1024


class CsvEditError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _resolve(root, filename):
    name = str(filename or "").replace("\\", "/").strip()
    if not name or not name.lower().endswith(".csv"):
        raise CsvEditError("文件名必须以 .csv 结尾")
    parts = name.split("/")
    if any(p in ("", ".", "..") or ":" in p or p.startswith(".") for p in parts):
        raise CsvEditError("无效的 CSV 相对路径")
    if any(any(c in p for c in '<>\"|?*') or p.endswith((" ", ".")) for p in parts):
        raise CsvEditError("文件名包含不支持的字符")
    base = Path(root).resolve()
    path = base.joinpath(*parts).resolve()
    if base not in path.parents:
        raise CsvEditError("CSV 路径必须位于 input/csv 内")
    return name, path


def _read_bytes(path):
    try:
        with path.open("rb") as f:
            raw = f.read(MAX_BYTES + 1)
    except FileNotFoundError as e:
        raise CsvEditError("CSV 文件不存在", 404) from e
    if len(raw) > MAX_BYTES:
        raise CsvEditError("编辑器支持最大 8 MB 的 CSV 文件", 413)
    return raw


def _decode(raw):
    if raw.startswith(codecs.BOM_UTF8):
        candidates = ("utf-8-sig",)
    else:
        candidates = ("utf-8", "gb18030")
    for encoding in candidates:
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    raise CsvEditError("无法无损读取文件编码，请先将文件转为 UTF-8")


def _parse(raw):
    text, encoding = _decode(raw)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=[",", ";", "\t", "|"])
    except csv.Error:
        dialect = csv.excel
    try:
        # Keep whitespace, duplicate labels, blank rows and every extra column.
        rows = list(csv.reader(io.StringIO(text, newline=""), dialect, strict=True, skipinitialspace=False, doublequote=True))
    except csv.Error as e:
        raise CsvEditError(f"CSV 格式无法安全编辑：{e}") from e
    newline = "\r\n" if "\r\n" in text else ("\n" if "\n" in text else ("\r" if "\r" in text else "\r\n"))
    return rows, encoding, dialect, newline, text.endswith(("\n", "\r"))


def _revision(raw):
    return hashlib.sha256(raw).hexdigest()


def read_document(root, filename):
    name, path = _resolve(root, filename)
    raw = _read_bytes(path)
    rows, encoding, dialect, newline, _ = _parse(raw)
    return {
        "filename": name,
        "rows": rows,
        "revision": _revision(raw),
        "encoding": encoding,
        "delimiter": dialect.delimiter,
        "newline": newline,
    }


def save_document(root, filename, rows, revision, save_as=None):
    if not isinstance(rows, list) or len(rows) > 100000:
        raise CsvEditError("rows 必须是 CSV 行数组（最多 100000 行）")
    if any(not isinstance(row, list) or len(row) > 1024 or any(not isinstance(cell, str) for cell in row) for row in rows):
        raise CsvEditError("每行必须是字符串数组（最多 1024 列）")
    if not isinstance(revision, str) or len(revision) != 64:
        raise CsvEditError("缺少文件版本，请重新打开编辑器")
    name, path = _resolve(root, filename)
    target_name, target = _resolve(root, save_as) if save_as else (name, path)
    with _EDIT_LOCK:
        raw = _read_bytes(path)
        if _revision(raw) != revision and not save_as:
            raise CsvEditError("文件已被其他编辑器修改。可另存为新文件保留当前修改，或关闭后重新打开文件。", 409)
        original_rows, encoding, dialect, newline, trailing_newline = _parse(raw)
        if rows == original_rows:
            output = raw
        else:
            stream = io.StringIO(newline="")
            csv.writer(stream, dialect, lineterminator=newline, doublequote=True).writerows(rows)
            text = stream.getvalue()
            # A final blank row needs its line terminator to remain a blank row.
            if not trailing_newline and text.endswith(newline) and rows and rows[-1]:
                text = text[:-len(newline)]
            try:
                output = text.encode(encoding)
            except UnicodeEncodeError as e:
                raise CsvEditError("新内容无法使用原文件编码保存，请先将文件转为 UTF-8") from e
            # Refuse serialization that changes cells, including unusual CSV dialects.
            roundtrip = list(csv.reader(io.StringIO(text, newline=""), dialect, strict=True, skipinitialspace=False, doublequote=True))
            if roundtrip != rows:
                raise CsvEditError("当前 CSV 格式无法无损保存这些内容")
        if len(output) > MAX_BYTES:
            raise CsvEditError("保存后文件超过 8 MB", 413)
        same_target = target == path
        if save_as and same_target:
            raise CsvEditError("另存为请使用不同的文件名")
        if same_target and output == raw:
            return {**read_document(root, name), "changed": False, "backup": None}
        if not target.parent.is_dir():
            raise CsvEditError("目标文件夹不存在，请选择已有文件夹")
        if not same_target and target.exists():
            raise CsvEditError("另存为的文件已存在，请更换文件名", 409)
        backup_name = None
        fd, temporary = tempfile.mkstemp(prefix=".csv-editor-", suffix=".tmp", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(output)
                f.flush()
                os.fsync(f.fileno())
            if same_target and _revision(_read_bytes(path)) != revision:
                raise CsvEditError("文件在保存时发生变化，请重新打开后再保存", 409)
            if same_target:
                base = Path(root).resolve()
                backup_dir = base / ".csv-editor-backups" / Path(name).parent
                backup_dir.mkdir(parents=True, exist_ok=True)
                if base not in backup_dir.resolve().parents:
                    raise CsvEditError("备份路径不在 CSV 文件夹内")
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
                backup = backup_dir / f"{path.name}.{stamp}.{uuid.uuid4().hex[:8]}.bak"
                with backup.open("xb") as f:
                    f.write(raw)
                    f.flush()
                    os.fsync(f.fileno())
                backup_name = backup.relative_to(base).as_posix()
                os.replace(temporary, target)
            else:
                # Exclusive publish: never overwrite a file created since the check.
                try:
                    if os.name == "nt":
                        os.rename(temporary, target)  # Windows rename refuses existing targets.
                    else:
                        os.link(temporary, target)
                except FileExistsError as e:
                    raise CsvEditError("另存为的文件已存在，请更换文件名", 409) from e
            return {**read_document(root, target_name), "changed": True, "backup": backup_name}
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
