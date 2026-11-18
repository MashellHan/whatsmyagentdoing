"""Read retained Pi usage into Agent Town's local token event shape."""

import argparse
import datetime as dt
import hashlib
import json
from itertools import islice
import os
import re
import stat
from pathlib import Path

UTC = dt.timezone.utc
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
SESSION_ID = re.compile(UUID, re.I)
PARENT_FILE = re.compile(r"_(" + UUID + r")\.jsonl$", re.I)
ENTRY_ID = re.compile(r"(?:[0-9a-f]{8}|" + UUID + r")", re.I)
LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}")
SDK_FIELDS = ("input", "cacheRead", "cacheWrite", "output")
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_SCAN_BYTES = 512 * 1024 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_HEADER_BYTES = 16 * 1024
MAX_FILES = 1024
MAX_SAFE_INTEGER = 2**53 - 1
CATEGORIES = ("work", "personal", "unclassified")


def _instant(value):
    try:
        date = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return date.astimezone(UTC) if date.tzinfo is not None else None
    except (AttributeError, ValueError, OverflowError):
        return None


def _integer(value):
    return value if type(value) is int and 0 <= value <= MAX_SAFE_INTEGER else None


def _label(value):
    return value if isinstance(value, str) and LABEL.fullmatch(value) else "unknown"


def _id(value, pattern):
    return value.lower() if isinstance(value, str) and pattern.fullmatch(value) else None


def _key(*values):
    return hashlib.sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


def _open(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    stream = os.fdopen(fd, "rb")
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
        stream.close()
        raise ValueError("not a regular usage file")
    return stream


def _object(line):
    row = json.loads(line)
    if not isinstance(row, dict):
        raise ValueError("non-object usage row")
    return row


def _rows(path, reject):
    with _open(path) as stream:
        remaining = os.fstat(stream.fileno()).st_size
        if remaining > MAX_FILE_BYTES:
            reject("FileBudget")
            return
        while remaining:
            line = stream.readline(min(MAX_RECORD_BYTES + 1, remaining))
            if not line.endswith(b"\n") or len(line) > MAX_RECORD_BYTES:
                reject("IncompleteOrOversizeRecord")
                return
            remaining -= len(line)
            try:
                yield _object(line)
            except (UnicodeError, ValueError):
                reject("InvalidRecord")


def _category(cwd, repositories):
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        return "unclassified"
    try:
        cwd = Path(cwd).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return "unclassified"
    candidates = []
    for repo in repositories:
        if repo.get("category") not in CATEGORIES or not isinstance(repo.get("path"), str):
            continue
        try:
            root = Path(repo["path"]).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            continue
        if cwd.is_relative_to(root):
            candidates.append((len(root.parts), repo["category"]))
    if not candidates:
        return "unclassified"
    longest = max(length for length, _ in candidates)
    categories = {category for length, category in candidates if length == longest}
    return categories.pop() if len(categories) == 1 else "unclassified"


def collect_pi(home, repositories, start, end):
    """Return local events, source gaps and private coverage. The inputs are read only."""
    home = Path(home).resolve()
    errors, cover, events, poisoned = set(), {}, {}, set()
    scan_bytes = 0

    def reject(source, code):
        errors.add((source, code))

    def files(source, relative, pattern, include=lambda path: True):
        nonlocal scan_bytes
        root = home / relative
        coverage = cover[source] = {"files": 0, "rows": 0, "missingFields": {}, "present": False}
        try:
            if not root.is_dir():
                return
            if root.resolve(strict=True) != root:
                reject(source, "UnverifiedRoot")
                return
            coverage["present"] = True
            for index, path in enumerate(islice((path for path in root.glob(pattern) if include(path)), MAX_FILES + 1)):
                if index == MAX_FILES:
                    reject(source, "FileCountBudget")
                    return
                if path.is_symlink() or path.parent.is_symlink() or not path.is_file():
                    reject(source, "UnverifiedFile")
                    continue
                coverage["files"] += 1
                scan_bytes += path.stat().st_size
                if scan_bytes > MAX_SCAN_BYTES:
                    reject(source, "TotalReadBudget")
                    return
                yield path
        except (OSError, RuntimeError):
            reject(source, "ReadUnavailable")

    def book(source, key, date, model, category, numbers, depth=0, provider="pi"):
        coverage = cover[source]
        coverage["rows"] += 1
        for field, value in numbers.items():
            if value is None:
                missing = coverage["missingFields"]
                missing[field] = missing.get(field, 0) + 1
        if numbers["input"] == numbers["cacheRead"] == numbers["output"] == 0:
            return
        payload = {"key": key, "at": date.isoformat().replace("+00:00", "Z"), "provider": "pi",
                   "model": model, "category": category, **numbers}
        if key in poisoned:
            return
        previous = events.get(key)
        if previous:
            older, older_depth, older_provider = previous
            if provider != older_provider or any(older[field] != payload[field] for field in ("model", *numbers)):
                del events[key]
                poisoned.add(key)
                reject(source, "ConflictingUsage")
                return
            if older_depth < depth or (source == "pi-host" and older["at"] < payload["at"]):
                return
            if older_depth == depth and older["category"] != category:
                payload["category"] = "unclassified"
        events[key] = (payload, depth, provider)

    headers, records, conflicting = {}, [], set()
    for source, relative in (("pi-team", ".local/share/mausbot-team/pi-agent/sessions"),
                             ("pi-cli", ".pi/agent/sessions")):
        for path in files(source, relative, "*/*.jsonl"):
            try:
                with _open(path) as stream:
                    line = stream.readline(MAX_HEADER_BYTES + 1)
                if not line.endswith(b"\n") or len(line) > MAX_HEADER_BYTES:
                    raise ValueError("invalid Pi session header")
                header = _object(line)
                sid = _id(header.get("id"), SESSION_ID)
                if header.get("type") != "session" or header.get("version") != 3 or not sid:
                    raise ValueError("unsupported Pi session")
                parent = header.get("parentSession")
                parent_match = PARENT_FILE.search(Path(parent).name) if isinstance(parent, str) else None
                if parent and not parent_match:
                    reject(source, "UnknownForkParent")
                    continue
                parent_id = parent_match[1].lower() if parent_match else None
                if sid in headers and headers[sid] != parent_id:
                    conflicting.add(sid)
                headers[sid] = parent_id
                records.append((source, path, sid, header.get("cwd"), _instant(header.get("timestamp"))))
            except (OSError, UnicodeError, ValueError):
                reject(source, "InvalidSessionHeader")

    for source, path, sid, cwd, created in records:
        root, ancestors = sid, set()
        while root in headers and root not in ancestors and root not in conflicting and headers[root]:
            ancestors.add(root)
            root = headers[root]
        if root in ancestors or root in conflicting:
            reject(source, "ConflictingForkLineage")
            continue
        if root not in headers:
            reject(source, "MissingForkParent")
        # A retained fork alone cannot establish the repository of inherited calls.
        category = _category(cwd, repositories)
        try:
            rows = _rows(path, lambda code: reject(source, code))
            next(rows, None)
            for row in rows:
                if row.get("type") == "message":
                    message = row.get("message")
                    if not isinstance(message, dict) or message.get("role") != "assistant":
                        continue
                elif row.get("type") == "usage":
                    message = row
                else:
                    continue
                date = _instant(row.get("timestamp"))
                entry = _id(row.get("id"), ENTRY_ID)
                if date is None or entry is None:
                    reject(source, "MissingEventIdentity")
                    continue
                if not start <= date < end:
                    continue
                usage = message.get("usage")
                if not isinstance(usage, dict):
                    reject(source, "MissingUsage")
                    continue
                fresh, read, write, output = (_integer(usage.get(key)) for key in SDK_FIELDS)
                if None in (fresh, read, write, output):
                    reject(source, "IncompleteUsage")
                incoming = _integer(fresh + write) if fresh is not None and write is not None else None
                if incoming is None:
                    reject(source, "IncompleteUsage")
                total = _integer(usage.get("totalTokens"))
                if total is not None and None not in (incoming, read, output) and total != incoming + read + output:
                    reject(source, "ConflictingTokenTotal")
                    continue
                reasoning = _integer(usage.get("reasoning"))
                model = _label(message.get("model"))
                provider = _label(message.get("provider"))
                book(source, _key("pi-cli", root, entry, date.isoformat()), date, model,
                     category if root == sid or (created and date > created) else "unclassified",
                     {"input": incoming, "cacheRead": read, "cacheWrite": write, "output": output,
                      "reasoning": reasoning if reasoning is not None and output is not None and reasoning <= output else None},
                     len(ancestors), provider)
        except (OSError, ValueError):
            reject(source, "ReadUnavailable")

    start_month = start.astimezone(UTC).strftime("%Y-%m")
    end_month = end.astimezone(UTC).strftime("%Y-%m")
    for path in files("pi-host", ".openmausbot/usage", "????-??.jsonl",
                      lambda path: start_month <= path.stem <= end_month):
        source = "pi-host"
        try:
            for row in _rows(path, lambda code: reject(source, code)):
                if row.get("driverKind") != "piAgent":
                    continue
                date = _instant(row.get("at"))
                if date is None:
                    reject(source, "MissingEventIdentity")
                    continue
                if not start <= date < end:
                    continue
                identifiers = [row.get(key) for key in ("botId", "threadId")]
                if any(not isinstance(key, str) or not 0 < len(key) <= 128 for key in identifiers):
                    reject(source, "MissingEventIdentity")
                    continue
                turn = row.get("turnId")
                if turn and (not isinstance(turn, str) or len(turn) > 128):
                    reject(source, "MissingEventIdentity")
                    continue
                total, read, output = (_integer(row.get(key)) for key in ("input", "cachedInput", "output"))
                incoming = total - read if total is not None and read is not None and read <= total else None
                if incoming is None or output is None or row.get("usageStatus") in ("partial", "unavailable"):
                    reject(source, "IncompleteUsage")
                if row.get("usageStatus") == "unavailable":
                    continue
                write, reasoning = _integer(row.get("cacheWrite")), _integer(row.get("reasoning"))
                # The Pi RPC driver runs with --no-session; booked turns are independent of CLI entries.
                book(source, _key("pi-host", *identifiers, turn or date.isoformat()), date, _label(row.get("model")), "unclassified",
                     {"input": incoming, "cacheRead": read if incoming is not None else None,
                      "cacheWrite": write if write is not None and incoming is not None and write <= incoming else None,
                      "output": output,
                      "reasoning": reasoning if reasoning is not None and output is not None and reasoning <= output else None})
        except (OSError, ValueError):
            reject(source, "ReadUnavailable")
    if not any(item["files"] for item in cover.values()):
        reject("pi", "NoRetainedSources")
    return {"tokens": [row for row, _, _ in events.values()], "coverage": cover,
            "errors": [{"source": source, "code": code} for source, code in sorted(errors)]}

 
def augment_pi_usage(sample, home, repositories, start, end):
    """Add Pi at the local collector's machine-event boundary, before aggregation."""
    pi = collect_pi(home, repositories, start, end)
    if "piCoverage" in sample:
        raise ValueError("use a fresh machine sample before aggregation")
    sample["tokens"].extend(pi["tokens"])
    sample["errors"].extend(pi["errors"])
    if pi["errors"] and sample.get("status") == "ok":
        sample["status"] = "partial"
    sample["logFiles"] += sum(source["files"] for source in pi["coverage"].values())
    sample["piCoverage"] = pi["coverage"]
    return sample


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--start", required=True, type=_instant)
    parser.add_argument("--end", required=True, type=_instant)
    parser.add_argument("--repositories", required=True, type=Path)
    parser.add_argument("--sample", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.start is None or args.end is None or not args.start < args.end or args.end - args.start > dt.timedelta(days=60):
        parser.error("provide a timezone-aware interval of at most 60 days")
    try:
        sample = json.loads(args.sample.read_text())
        repos = json.loads(args.repositories.read_text())
        result = augment_pi_usage(sample, args.home, repos, args.start, args.end)
        fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(result, stream)
            stream.write("\n")
    except (OSError, KeyError, TypeError, ValueError):
        parser.error("invalid private input or existing output")


if __name__ == "__main__":
    main()
