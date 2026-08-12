#!/usr/bin/env python3
"""
Infinite Corridor IC2.1 public knowledge trainer for Windows/macOS/Linux.

Produces: ic2-public-knowledge.json
Drop that JSON into the root of the Infinite Corridor GitHub Pages repository.

Default safety model:
- --public-pack may use curated public/open-license sources.
- Local --input folders are NOT included in a public pack unless
  --include-local-in-public-pack is explicitly supplied.
- Generic open directories are crawled only when you explicitly provide
  --open-dir URLs.
- No third-party Python packages are required.

The output contains literal dictionary byte fragments. Do not publish a pack
trained on private/sensitive files unless you deliberately accept that risk.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import dataclasses
import hashlib
import html.parser
import json
import mimetypes
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Iterator, Optional

FORMAT = "IC2_PUBLIC_KNOWLEDGE_V1"
SAMPLE_BYTES = 2048
SAMPLES_PER_FILE = 24
MAX_PROFILE_SAMPLES = 96
DICTIONARY_BYTES = 16 * 1024
DEFAULT_MAX_FILE = 8 * 1024 * 1024
UA = "InfiniteCorridorKnowledgeTrainer/1.0 (+static GitHub Pages research client)"

SAFE_LICENSE_HINTS = (
    "publicdomain", "public domain", "cc0", "creativecommons.org/publicdomain",
    "creativecommons.org/licenses/by/", "creativecommons.org/licenses/by-sa/",
    "apache-2.0", "mit", "bsd", "isc", "unlicense", "mpl-2.0", "gpl", "lgpl"
)

DEFAULT_EXTENSIONS = {
    ".txt",".md",".html",".htm",".json",".jsonl",".xml",".csv",".tsv",
    ".css",".js",".mjs",".cjs",".py",".c",".h",".cpp",".hpp",".java",".rs",
    ".go",".toml",".yaml",".yml",".ini",".cfg",".conf",".sql",
    ".pdf",".svg",".png",".jpg",".jpeg",".gif",".webp",
    ".wav",".flac",".ogg",".mp3",".mp4",".webm",
    ".zip",".gz",".tar",".7z",".wasm",".bin",".iso",
    ".safetensors",".gguf",".onnx",".parquet",".arrow"
}

@dataclasses.dataclass
class Candidate:
    url: str
    name: str
    size: int = 0
    source: str = "web"
    license_hint: str = ""
    local_path: Optional[Path] = None

@dataclasses.dataclass
class Sample:
    digest: str
    data: bytes
    hits: int = 1

@dataclasses.dataclass
class Profile:
    files: int = 0
    observed_bytes: int = 0
    samples: dict[str, Sample] = dataclasses.field(default_factory=dict)
    sources: dict[str, int] = dataclasses.field(default_factory=lambda: defaultdict(int))


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def profile_for_name(name: str, mime: str = "") -> str:
    suffix = Path(urllib.parse.urlparse(name).path).suffix.lower()
    ext = re.sub(r"[^a-z0-9]", "", suffix.lstrip("."))[:12]
    if ext:
        return f"ext:{ext}"
    if mime:
        return f"mime:{mime.lower()[:80]}"
    return "generic"


def allowed_extension(name: str, extensions: set[str]) -> bool:
    suffix = Path(urllib.parse.urlparse(name).path).suffix.lower()
    return not extensions or suffix in extensions


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def request(url: str, *, method: str = "GET", headers: Optional[dict] = None, timeout: int = 30):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    return urllib.request.urlopen(urllib.request.Request(url, method=method, headers=h), timeout=timeout)


def json_get(url: str, timeout: int = 30):
    with request(url, headers={"Accept":"application/json"}, timeout=timeout) as r:
        return json.load(r)


def content_length(url: str) -> int:
    try:
        with request(url, method="HEAD", timeout=15) as r:
            return int(r.headers.get("Content-Length") or 0)
    except Exception:
        return 0


def remote_bytes(c: Candidate, max_file: int) -> Optional[bytes]:
    if c.size and c.size > max_file:
        return None
    try:
        with request(c.url, timeout=60) as r:
            header_size = int(r.headers.get("Content-Length") or 0)
            if header_size and header_size > max_file:
                return None
            data = r.read(max_file + 1)
        if len(data) > max_file:
            return None
        return data
    except Exception as exc:
        print(f"[skip] {c.source}: {c.name}: {exc}", file=sys.stderr)
        return None


def local_sample_positions(size: int) -> list[int]:
    if size <= SAMPLE_BYTES:
        return [0]
    step = max(4096, size // SAMPLES_PER_FILE)
    positions = []
    off = 0
    while off < size and len(positions) < SAMPLES_PER_FILE:
        positions.append(min(off, max(0, size - SAMPLE_BYTES)))
        off += step
    return list(dict.fromkeys(positions))


def samples_from_bytes(data: bytes) -> list[bytes]:
    out = []
    for start in local_sample_positions(len(data)):
        part = data[start:start+SAMPLE_BYTES]
        if len(part) >= 256:
            out.append(part)
    return out


def samples_from_file(path: Path) -> tuple[list[bytes], int]:
    size = path.stat().st_size
    out = []
    with path.open("rb") as f:
        for start in local_sample_positions(size):
            f.seek(start)
            part = f.read(SAMPLE_BYTES)
            if len(part) >= 256:
                out.append(part)
    return out, size


def record_samples(profiles: dict[str, Profile], name: str, source: str, data_samples: Iterable[bytes], size: int, mime: str = ""):
    pkey = profile_for_name(name, mime)
    p = profiles.setdefault(pkey, Profile())
    p.files += 1
    p.observed_bytes += size
    p.sources[source] += 1
    for data in data_samples:
        digest = sha256(data)
        old = p.samples.get(digest)
        if old:
            old.hits += 1
        else:
            p.samples[digest] = Sample(digest, data, 1)


def prune_and_dictionary(p: Profile) -> tuple[list[Sample], bytes]:
    samples = list(p.samples.values())
    def score(s: Sample):
        diversity = len(set(s.data))
        repeats = len(s.data) - len(set(s.data[i:i+16] for i in range(0, len(s.data), 16)))
        return (s.hits, repeats, -diversity, s.digest)
    samples.sort(key=score, reverse=True)
    samples = samples[:MAX_PROFILE_SAMPLES]
    buf = bytearray()
    for s in samples:
        if len(buf) >= DICTIONARY_BYTES:
            break
        take = min(len(s.data), DICTIONARY_BYTES - len(buf))
        buf.extend(s.data[:take])
    return samples, bytes(buf)


def local_candidates(inputs: list[str], extensions: set[str]) -> Iterator[Candidate]:
    for raw in inputs:
        root = Path(raw).expanduser()
        if not root.exists():
            print(f"[skip] local path not found: {root}", file=sys.stderr)
            continue
        paths = [root] if root.is_file() else root.rglob("*")
        for path in paths:
            try:
                if path.is_file() and allowed_extension(path.name, extensions):
                    yield Candidate("", path.name, path.stat().st_size, "local", local_path=path)
            except (OSError, PermissionError):
                continue


def archive_candidates(items: int, max_file: int, extensions: set[str]) -> Iterator[Candidate]:
    queries = [
        'collection:gutenberg',
        '(licenseurl:*creativecommons* OR licenseurl:*publicdomain*) AND mediatype:(texts OR image OR audio OR movies OR software)',
    ]
    per = max(10, items * 2)
    seen = set()
    for q in queries:
        if len(seen) >= items:
            break
        params = urllib.parse.urlencode({
            "q": q, "fl[]": ["identifier","title"], "rows": per,
            "page": random.randint(1, 25), "output":"json"
        }, doseq=True)
        try:
            docs = json_get("https://archive.org/advancedsearch.php?" + params).get("response",{}).get("docs",[])
        except Exception as exc:
            print(f"[warn] Internet Archive search failed: {exc}", file=sys.stderr)
            continue
        random.shuffle(docs)
        for doc in docs:
            if len(seen) >= items:
                return
            ident = doc.get("identifier")
            if not ident or ident in seen:
                continue
            try:
                meta = json_get("https://archive.org/metadata/" + urllib.parse.quote(ident, safe=""))
            except Exception:
                continue
            md = meta.get("metadata", {})
            license_hint = str(md.get("licenseurl") or md.get("rights") or "")
            if "gutenberg" not in str(md.get("collection","")).lower() and license_hint:
                if not any(h in license_hint.lower() for h in SAFE_LICENSE_HINTS):
                    continue
            files = []
            for f in meta.get("files", []):
                name = str(f.get("name") or "")
                try:
                    size = int(f.get("size") or 0)
                except Exception:
                    size = 0
                if not name or not allowed_extension(name, extensions):
                    continue
                if size and not (256 <= size <= max_file):
                    continue
                source_tag = str(f.get("source") or "")
                priority = 0 if source_tag == "original" else 1
                files.append((priority, size or max_file, name, size))
            files.sort()
            if not files:
                continue
            _, _, name, size = files[0]
            url = "https://archive.org/download/{}/{}".format(
                urllib.parse.quote(ident, safe=""),
                "/".join(urllib.parse.quote(x, safe="") for x in name.split("/"))
            )
            seen.add(ident)
            yield Candidate(url, name, size, "archive.org", license_hint)


class LinkParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
    def handle_starttag(self, tag, attrs):
        if tag.lower() == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)


def open_directory_candidates(roots: list[str], max_file: int, extensions: set[str], max_depth: int = 2) -> Iterator[Candidate]:
    for root in roots:
        root = root.rstrip("/") + "/"
        rp = urllib.parse.urlparse(root)
        if rp.scheme not in ("http","https"):
            print(f"[skip] open-dir must be http(s): {root}", file=sys.stderr)
            continue
        base_path = rp.path
        todo = [(root, 0)]
        seen_pages = set()
        while todo:
            page, depth = todo.pop(0)
            if page in seen_pages or depth > max_depth:
                continue
            seen_pages.add(page)
            try:
                with request(page, headers={"Accept":"text/html"}, timeout=30) as r:
                    ctype = r.headers.get("Content-Type","")
                    if "html" not in ctype.lower():
                        continue
                    text = r.read(2*1024*1024).decode("utf-8","replace")
            except Exception as exc:
                print(f"[skip] open-dir index {page}: {exc}", file=sys.stderr)
                continue
            parser = LinkParser(); parser.feed(text)
            for href in parser.links:
                if href.startswith(("#","?")) or href in ("../","./"):
                    continue
                url = urllib.parse.urljoin(page, href)
                u = urllib.parse.urlparse(url)
                if u.scheme not in ("http","https") or u.netloc != rp.netloc:
                    continue
                if not u.path.startswith(base_path):
                    continue
                if u.path.endswith("/"):
                    if depth < max_depth:
                        todo.append((url, depth+1))
                    continue
                name = urllib.parse.unquote(u.path.rsplit("/",1)[-1])
                if not allowed_extension(name, extensions):
                    continue
                size = content_length(url)
                if size and size > max_file:
                    continue
                yield Candidate(url, name, size, "open-directory")


def commons_candidates(items: int, max_file: int, extensions: set[str]) -> Iterator[Candidate]:
    got = 0
    while got < items:
        batch = min(50, max(10, items-got))
        params = urllib.parse.urlencode({
            "action":"query","format":"json","generator":"random",
            "grnnamespace":"6","grnlimit":str(batch),
            "prop":"imageinfo","iiprop":"url|size|mime|extmetadata"
        })
        try:
            obj = json_get("https://commons.wikimedia.org/w/api.php?" + params)
        except Exception as exc:
            print(f"[warn] Wikimedia Commons API failed: {exc}", file=sys.stderr)
            return
        pages = list((obj.get("query",{}).get("pages") or {}).values())
        if not pages:
            return
        for page in pages:
            if got >= items:
                return
            info = (page.get("imageinfo") or [{}])[0]
            url = info.get("url")
            size = int(info.get("size") or 0)
            name = str(page.get("title") or "File:unknown").removeprefix("File:")
            if not url or not allowed_extension(name, extensions):
                continue
            if size and not (256 <= size <= max_file):
                continue
            ext = info.get("extmetadata") or {}
            license_hint = str((ext.get("LicenseShortName") or {}).get("value") or "")
            got += 1
            yield Candidate(url, name, size, "wikimedia-commons", license_hint)


def github_candidates(specs: list[str], max_file: int, extensions: set[str], token: str = "") -> Iterator[Candidate]:
    headers = {"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2026-03-10"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for spec in specs:
        if "@" in spec:
            repo, ref = spec.rsplit("@",1)
        else:
            repo, ref = spec, ""
        if repo.count("/") != 1:
            print(f"[skip] GitHub repo should be owner/repo[@ref]: {spec}", file=sys.stderr)
            continue
        owner, name = repo.split("/",1)
        try:
            meta_url=f"https://api.github.com/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}"
            with request(meta_url, headers=headers) as r:
                meta=json.load(r)
            ref = ref or meta.get("default_branch") or "main"
            license_hint = str((meta.get("license") or {}).get("spdx_id") or "")
            if not license_hint or license_hint == "NOASSERTION":
                print(f"[skip] GitHub repo has no machine-readable license: {repo}", file=sys.stderr)
                continue
            tree_url=f"https://api.github.com/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}/git/trees/{urllib.parse.quote(ref,safe='')}?recursive=1"
            with request(tree_url, headers=headers) as r:
                tree=json.load(r)
        except Exception as exc:
            print(f"[warn] GitHub {repo}: {exc}", file=sys.stderr)
            continue
        files=[x for x in tree.get("tree",[]) if x.get("type")=="blob"]
        random.shuffle(files)
        for x in files:
            path=x.get("path",""); size=int(x.get("size") or 0)
            if not path or not allowed_extension(path, extensions):
                continue
            if size and not (256 <= size <= max_file):
                continue
            raw="https://raw.githubusercontent.com/{}/{}/{}/{}".format(
                urllib.parse.quote(owner), urllib.parse.quote(name),
                urllib.parse.quote(ref, safe=""),
                "/".join(urllib.parse.quote(p, safe="") for p in path.split("/"))
            )
            yield Candidate(raw, path, size, f"github:{repo}", license_hint)


def hf_candidates(specs: list[str], max_file: int, extensions: set[str], token: str = "") -> Iterator[Candidate]:
    for spec in specs:
        kind, _, repo = spec.partition(":")
        if kind not in ("dataset","model","space") or "/" not in repo:
            print(f"[skip] HF spec should be dataset:owner/name, model:owner/name, or space:owner/name: {spec}", file=sys.stderr)
            continue
        api_prefix={"dataset":"datasets","model":"models","space":"spaces"}[kind]
        web_prefix={"dataset":"datasets","model":"","space":"spaces"}[kind]
        headers={"Accept":"application/json"}
        if token:
            headers["Authorization"]=f"Bearer {token}"
        try:
            with request(f"https://huggingface.co/api/{api_prefix}/{repo}", headers=headers) as r:
                meta=json.load(r)
            tags=[str(x).lower() for x in meta.get("tags",[])]
            license_hint=next((x.split("license:",1)[1] for x in tags if x.startswith("license:")), "")
            if not license_hint:
                card=meta.get("cardData") or {}
                license_hint=str(card.get("license") or "")
            if not license_hint:
                print(f"[skip] Hugging Face repo has no declared license: {spec}", file=sys.stderr)
                continue
            tree_url=f"https://huggingface.co/api/{api_prefix}/{repo}/tree/main?recursive=true&expand=false"
            with request(tree_url, headers=headers) as r:
                entries=json.load(r)
        except Exception as exc:
            print(f"[warn] Hugging Face {spec}: {exc}", file=sys.stderr)
            continue
        for x in entries if isinstance(entries,list) else []:
            if x.get("type")!="file":
                continue
            path=str(x.get("path") or "")
            size=int(x.get("size") or 0)
            if not path or not allowed_extension(path,extensions):
                continue
            if size and not (256 <= size <= max_file):
                continue
            prefix=(web_prefix + "/") if web_prefix else ""
            url=f"https://huggingface.co/{prefix}{repo}/resolve/main/" + "/".join(urllib.parse.quote(p,safe="") for p in path.split("/")) + "?download=true"
            yield Candidate(url,path,size,f"huggingface:{spec}",license_hint)


def gutenberg_candidates(items: int, max_file: int, extensions: set[str]) -> Iterator[Candidate]:
    harvest="https://www.gutenberg.org/robot/harvest?filetypes[]=txt"
    try:
        with request(harvest, headers={"Accept":"text/html"}, timeout=30) as r:
            text=r.read(2*1024*1024).decode("utf-8","replace")
    except Exception as exc:
        print(f"[warn] Gutenberg harvest failed: {exc}", file=sys.stderr)
        return
    parser=LinkParser(); parser.feed(text)
    links=[]
    for href in parser.links:
        url=urllib.parse.urljoin(harvest,href)
        name=urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit("/",1)[-1])
        if allowed_extension(name,extensions) or name.lower().endswith(".zip"):
            links.append((url,name))
    random.shuffle(links)
    for url,name in links[:items]:
        size=content_length(url)
        if size and size>max_file:
            continue
        yield Candidate(url,name,size,"project-gutenberg","public-domain")
        time.sleep(2.0)


def s3_candidates(list_urls: list[str], max_file: int, extensions: set[str], max_keys: int = 1000) -> Iterator[Candidate]:
    for raw in list_urls:
        parsed=urllib.parse.urlparse(raw)
        if parsed.scheme not in ("http","https"):
            continue
        token=None; seen=0
        while seen<max_keys:
            q=urllib.parse.parse_qs(parsed.query)
            q["list-type"]=["2"]
            if token: q["continuation-token"]=[token]
            url=urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(q,doseq=True)))
            try:
                with request(url, headers={"Accept":"application/xml"}, timeout=30) as r:
                    root=ET.fromstring(r.read(4*1024*1024))
            except Exception as exc:
                print(f"[warn] S3 listing failed {raw}: {exc}", file=sys.stderr)
                break
            ns=""
            if root.tag.startswith("{"): ns=root.tag.split("}",1)[0]+"}"
            for node in root.findall(f".//{ns}Contents"):
                key=(node.findtext(f"{ns}Key") or "")
                size=int(node.findtext(f"{ns}Size") or 0)
                if not key or not allowed_extension(key,extensions) or (size and size>max_file):
                    continue
                base=f"{parsed.scheme}://{parsed.netloc}/"
                obj=base + "/".join(urllib.parse.quote(p,safe="") for p in key.split("/"))
                seen+=1
                yield Candidate(obj,key,size,"public-s3")
                if seen>=max_keys: break
            truncated=(root.findtext(f"{ns}IsTruncated") or "").lower()=="true"
            token=root.findtext(f"{ns}NextContinuationToken")
            if not truncated or not token: break


def url_list_candidates(paths: list[str], max_file: int, extensions: set[str]) -> Iterator[Candidate]:
    for p in paths:
        for line in Path(p).read_text("utf-8",errors="replace").splitlines():
            url=line.strip()
            if not url or url.startswith("#"): continue
            name=urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit("/",1)[-1]) or "download.bin"
            if not allowed_extension(name,extensions): continue
            size=content_length(url)
            if size and size>max_file: continue
            yield Candidate(url,name,size,"url-list")


def make_output(profiles: dict[str,Profile], source_stats: dict[str,dict], total_files: int, total_bytes: int) -> dict:
    out_profiles={}
    for key,p in sorted(profiles.items()):
        kept,dictionary=prune_and_dictionary(p)
        if not dictionary: continue
        out_profiles[key]={
            "files":p.files,
            "observed_bytes":p.observed_bytes,
            "sample_count":len(kept),
            "dictionary_bytes":len(dictionary),
            "dictionary_b64url":b64url(dictionary),
            "sources":dict(sorted(p.sources.items()))
        }
    return {
        "format":FORMAT,
        "version":1,
        "generated_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
        "sample_bytes":SAMPLE_BYTES,
        "dictionary_bytes_max":DICTIONARY_BYTES,
        "profiles":out_profiles,
        "stats":{
            "profiles":len(out_profiles),
            "files":total_files,
            "observed_bytes":total_bytes,
            "sources":source_stats
        }
    }


def parse_args():
    p=argparse.ArgumentParser(description="Train an IC2.1 public knowledge pack.")
    p.add_argument("--output",default="ic2-public-knowledge.json")
    p.add_argument("--report",default="ic2-training-report.json")
    p.add_argument("--input",action="append",default=[],help="Local file/folder. Repeatable.")
    p.add_argument("--include-local-in-public-pack",action="store_true",
                   help="Explicitly allow local bytes to enter the publishable JSON.")
    p.add_argument("--public-pack",action="store_true",help="Enable curated public-host training.")
    p.add_argument("--archive-items",type=int,default=30)
    p.add_argument("--commons-items",type=int,default=30)
    p.add_argument("--gutenberg-items",type=int,default=20)
    p.add_argument("--github-repo",action="append",default=[],help="owner/repo[@ref], repeatable; repo must declare a license.")
    p.add_argument("--hf-repo",action="append",default=[],help="dataset:owner/repo, model:owner/repo, or space:owner/repo.")
    p.add_argument("--open-dir",action="append",default=[],help="Explicit public HTTP directory index to crawl.")
    p.add_argument("--s3-list",action="append",default=[],help="Explicit public S3 bucket listing URL.")
    p.add_argument("--url-list",action="append",default=[],help="Text file containing direct public URLs.")
    p.add_argument("--github-token",default=os.environ.get("GITHUB_TOKEN",""))
    p.add_argument("--hf-token",default=os.environ.get("HF_TOKEN",""))
    p.add_argument("--max-file-mb",type=float,default=8)
    p.add_argument("--max-total-gb",type=float,default=2)
    p.add_argument("--workers",type=int,default=6)
    p.add_argument("--extensions",default=",".join(sorted(DEFAULT_EXTENSIONS)),help="Comma-separated extensions, including dots. Empty means all.")
    p.add_argument("--seed",type=int,default=None)
    return p.parse_args()


def main():
    a=parse_args()
    if a.seed is not None: random.seed(a.seed)
    max_file=int(a.max_file_mb*1024*1024)
    max_total=int(a.max_total_gb*1024*1024*1024)
    extensions={x.strip().lower() for x in a.extensions.split(",") if x.strip()}
    if a.input and not a.include_local_in_public_pack:
        print("[notice] Local --input files are excluded from the publishable pack. Use --include-local-in-public-pack only if those byte fragments are safe to publish.")
    profiles: dict[str,Profile]={}
    source_stats: dict[str,dict]=defaultdict(lambda:{"files":0,"bytes":0})
    total_files=0; total_bytes=0

    streams=[]
    if a.public_pack:
        streams += [
            archive_candidates(a.archive_items,max_file,extensions),
            commons_candidates(a.commons_items,max_file,extensions),
            gutenberg_candidates(a.gutenberg_items,max_file,extensions),
        ]
    if a.github_repo: streams.append(github_candidates(a.github_repo,max_file,extensions,a.github_token))
    if a.hf_repo: streams.append(hf_candidates(a.hf_repo,max_file,extensions,a.hf_token))
    if a.open_dir: streams.append(open_directory_candidates(a.open_dir,max_file,extensions))
    if a.s3_list: streams.append(s3_candidates(a.s3_list,max_file,extensions))
    if a.url_list: streams.append(url_list_candidates(a.url_list,max_file,extensions))
    if a.input and a.include_local_in_public_pack: streams.append(local_candidates(a.input,extensions))

    candidates=[]
    for stream in streams:
        try:
            for c in stream:
                if sum(x.size for x in candidates if x.size) >= max_total:
                    break
                candidates.append(c)
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"[warn] source enumeration failed: {exc}",file=sys.stderr)

    random.shuffle(candidates)
    print(f"[info] {len(candidates)} candidate files discovered.")

    def load(c):
        if c.local_path:
            try:
                sm,size=samples_from_file(c.local_path)
                return c,sm,size
            except Exception as exc:
                return c,None,exc
        data=remote_bytes(c,max_file)
        if data is None: return c,None,0
        return c,samples_from_bytes(data),len(data)

    with cf.ThreadPoolExecutor(max_workers=max(1,a.workers)) as ex:
        futures=[ex.submit(load,c) for c in candidates]
        for fut in cf.as_completed(futures):
            if total_bytes>=max_total: break
            c,samples,size=fut.result()
            if samples is None or isinstance(size,Exception): continue
            if total_bytes+size>max_total or not samples: continue
            mime=mimetypes.guess_type(c.name)[0] or ""
            record_samples(profiles,c.name,c.source,samples,size,mime)
            total_files+=1; total_bytes+=size
            ss=source_stats[c.source]; ss["files"]+=1; ss["bytes"]+=size
            print(f"[{total_files:04d}] {c.source:<22} {size/1024:9.1f} KiB  {c.name[:80]}")

    result=make_output(profiles,dict(source_stats),total_files,total_bytes)
    out=Path(a.output)
    out.write_text(json.dumps(result,separators=(",",":"),ensure_ascii=False),encoding="utf-8")
    report={
        "generated_at":result["generated_at"],
        "output":str(out.resolve()),
        "output_bytes":out.stat().st_size,
        "profiles":{k:{x:v[x] for x in ("files","observed_bytes","sample_count","dictionary_bytes")} for k,v in result["profiles"].items()},
        "stats":result["stats"],
        "warning":"The public knowledge JSON contains literal byte fragments in its dictionaries. Publish only data you are allowed to expose."
    }
    Path(a.report).write_text(json.dumps(report,indent=2),encoding="utf-8")
    print()
    print(f"[done] {out}  ({out.stat().st_size:,} bytes)")
    print(f"[done] profiles={len(result['profiles'])} files={total_files} observed={total_bytes:,} bytes")
    print("[next] Drag ic2-public-knowledge.json into the ROOT of pablo.github.io and commit it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
