"""지도 꾸러미를 길 그래프로 읽기(합성 동선 생성용)."""
import heapq
import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Graph:
    pkg: dict
    nodes: dict = field(default_factory=dict)
    edges: dict = field(default_factory=dict)
    adj: dict = field(default_factory=dict)  # node -> [(next, edge_key, forward)]
    area_nodes: dict = field(default_factory=dict)  # area_key -> [node_key]
    footprints: list = field(default_factory=list)


def load(path="data/package.json") -> Graph:
    pkg = json.loads(Path(path).read_text(encoding="utf-8"))
    g = Graph(pkg)
    g.nodes = {n["key"]: n for n in pkg["nodes"]}
    for e in pkg["edges"]:
        if e["pedestrianAccess"] == "prohibited":
            continue
        g.edges[e["key"]] = e
        if e["direction"] in ("both", "forward"):
            g.adj.setdefault(e["from"], []).append((e["to"], e["key"], True))
        if e["direction"] in ("both", "backward"):
            g.adj.setdefault(e["to"], []).append((e["from"], e["key"], False))
    for wn in pkg["walkAreaNodes"]:
        g.area_nodes.setdefault(wn["areaKey"], []).append(wn["nodeKey"])
    g.footprints = [b["footprint"] for b in pkg["buildings"] if b.get("footprint")]
    return g


def shortest_path(g: Graph, src: str, dst: str):
    """[(edge_key, forward)] 목록. 길이 없으면 None."""
    dist = {src: 0.0}
    prev = {}
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst:
            break
        if d > dist[u]:
            continue
        for v, ek, fwd in g.adj.get(u, []):
            nd = d + g.edges[ek]["lengthM"]
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = (u, ek, fwd)
                heapq.heappush(pq, (nd, v))
    if dst not in prev and dst != src:
        return None
    out = []
    v = dst
    while v != src:
        u, ek, fwd = prev[v]
        out.append((ek, fwd))
        v = u
    return out[::-1]


def edge_points(g: Graph, ek: str, forward: bool):
    pts = [tuple(p) for p in g.edges[ek]["geometry"]]
    return pts if forward else pts[::-1]


def edge_indoor(g: Graph, ek: str) -> bool:
    e = g.edges[ek]
    return g.nodes[e["from"]]["location"] == "indoor" or g.nodes[e["to"]]["location"] == "indoor"
