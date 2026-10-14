"""지도 꾸러미 받기: 로컬 백엔드(127.0.0.1:8010)에서 최신 릴리스를 받아 sha256 확인 후 data/package.json 저장."""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8010"


def main() -> None:
    base = sys.argv[1] if len(sys.argv) > 1 else BASE
    latest = json.load(urllib.request.urlopen(f"{base}/v1/map/releases/latest"))
    url = latest["url"] if latest["url"].startswith("http") else base + latest["url"]
    body = urllib.request.urlopen(url).read()
    digest = hashlib.sha256(body).hexdigest()
    if digest != latest["sha256"]:
        raise SystemExit(f"sha256 불일치: {digest} != {latest['sha256']}")
    out = Path("data/package.json")
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(body)
    print(f"release v{latest['version']} {len(body)} B sha256 ok -> {out}")


if __name__ == "__main__":
    main()
