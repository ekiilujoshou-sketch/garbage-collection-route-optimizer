"""Flask backend for Campus Waste Collection Route Optimizer."""

from __future__ import annotations

from typing import Dict, Tuple

import os
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from algorithms import (
    build_complete_graph,
    dijkstra_path,
    enforce_priority_window,
    efficiency_improvement,
    naive_route,
    nearest_neighbor_route,
    route_distance,
    two_opt,
    tsp_approx_route,
)

# Point Flask to the frontend folder (one level up from the backend folder)
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app)


CoordinateMap = Dict[str, Tuple[float, float]]

# In-memory storage for beginner-friendly demo usage.
NODE_STORE: CoordinateMap = {}


def _seconds_to_hhmmss(total_seconds: float) -> str:
    total = max(0, int(round(total_seconds)))
    hours = total // 3600
    minutes = (total % 3600) // 60
    seconds = total % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _enforce_route_end(route, start: str, end: str):
    """Return a route that starts at start and ends at end (if both exist)."""
    if not route or end not in route:
        return route
    middle = [node for node in route if node not in {start, end}]
    if start == end:
        return [start] + middle
    return [start] + middle + [end]


def _parse_nodes(payload) -> CoordinateMap:
    nodes = payload.get("nodes", [])
    parsed: CoordinateMap = {}

    for item in nodes:
        node_id = str(item["id"])
        parsed[node_id] = (float(item["lat"]), float(item["lng"]))
    return parsed


def _validate_route_request(payload):
    if not NODE_STORE:
        return "No nodes available. Use /add_nodes first."
    if len(NODE_STORE) < 2:
        return "Please add at least 2 nodes first."
    if "start" not in payload or payload.get("start") is None:
        return "Missing required field: start"
    start = str(payload.get("start"))
    if start not in NODE_STORE:
        return f"Start node '{start}' not found."
    return None


def _run_optimization(payload):
    start = str(payload.get("start"))
    end = str(payload.get("end")) if payload.get("end") is not None else None
    method = str(payload.get("method", "nearest_neighbor"))
    priority_bins = [str(x) for x in payload.get("priority_bins", []) if str(x) in NODE_STORE]

    graph = build_complete_graph(NODE_STORE)
    naive_r, naive_dist = naive_route(NODE_STORE, start)
    if end and end in NODE_STORE:
        naive_r = _enforce_route_end(naive_r, start, end)
        naive_dist = route_distance(naive_r, NODE_STORE)

    if method == "tsp_approx":
        base_route, _ = tsp_approx_route(graph, start)
    else:
        base_route, _ = nearest_neighbor_route(NODE_STORE, start)

    # Apply priority rule first, improve route shape with 2-opt,
    # then re-apply priority to guarantee final ordering respects priority window.
    priority_route = enforce_priority_window(base_route, priority_bins, start)
    optimized_route, _ = two_opt(priority_route, NODE_STORE)
    optimized_route = enforce_priority_window(optimized_route, priority_bins, start)
    if end and end in NODE_STORE:
        optimized_route = _enforce_route_end(optimized_route, start, end)
    optimized_distance = route_distance(optimized_route, NODE_STORE)

    improvement = efficiency_improvement(naive_dist, optimized_distance)

    # Basic demo metrics (distance-driven estimates).
    # Assumption: each km ~= 5 minutes of collection effort (driving + collecting).
    optimized_time_seconds = optimized_distance * 5.0 * 60.0
    naive_time_seconds = naive_dist * 5.0 * 60.0
    time_saved_seconds = max(0.0, naive_time_seconds - optimized_time_seconds)
    fuel_estimate = round(optimized_distance * 0.5, 2)

    return {
        "optimized_route": optimized_route,
        "naive_route": naive_r,
        "total_distance": round(optimized_distance, 2),
        "naive_distance": round(naive_dist, 2),
        "improvement_percent": round(improvement, 2),
        "metrics": {
            "optimized_time_estimate_hhmmss": _seconds_to_hhmmss(optimized_time_seconds),
            "naive_time_estimate_hhmmss": _seconds_to_hhmmss(naive_time_seconds),
            "time_difference_hhmmss": _seconds_to_hhmmss(time_saved_seconds),
            "fuel_estimate": fuel_estimate,
        },
        "method": method,
        "priority_bins": priority_bins,
    }


@app.route("/", methods=["GET"])
def home():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/add_nodes", methods=["POST"])
def add_nodes():
    """
    Add or replace node data.
    Expected JSON:
    {
      "nodes": [{"id":"A","lat":40.71,"lng":-74.00}, ...]
    }
    """
    global NODE_STORE

    try:
        payload = request.get_json(force=True) or {}
        parsed = _parse_nodes(payload)
        NODE_STORE = parsed
        return jsonify(
            {
                "message": "Nodes stored successfully.",
                "node_count": len(NODE_STORE),
                "nodes": [{"id": k, "lat": v[0], "lng": v[1]} for k, v in NODE_STORE.items()],
            }
        )
    except (KeyError, TypeError, ValueError) as exc:
        return jsonify({"error": f"Invalid payload: {exc}"}), 400


@app.route("/compute_route", methods=["POST"])
def compute_route():
    """
    Compute route using:
    - nearest_neighbor (default)
    - tsp_approx
    Also includes optional dijkstra path from start to end if end provided.
    """
    try:
        payload = request.get_json(force=True) or {}
        validation_error = _validate_route_request(payload)
        if validation_error:
            return jsonify({"error": validation_error}), 400

        result = _run_optimization(payload)
        start = str(payload.get("start"))
        graph = build_complete_graph(NODE_STORE)

        dijkstra_result = None
        end = payload.get("end")
        if end is not None:
            end = str(end)
            if end in NODE_STORE and end != start:
                d_path, d_dist = dijkstra_path(graph, start, end)
                dijkstra_result = {"path": d_path, "distance": round(d_dist, 2)}

        return jsonify(
            {
                "method": result["method"],
                "route": result["optimized_route"],
                "total_distance": result["total_distance"],
                "priority_bins": result["priority_bins"],
                "naive_route": result["naive_route"],
                "naive_distance": result["naive_distance"],
                "improvement_percent": result["improvement_percent"],
                "metrics": result["metrics"],
                "dijkstra": dijkstra_result,
            }
        )
    except Exception as exc:  # Keep beginner-friendly error handling.
        return jsonify({"error": str(exc)}), 400


@app.route("/compare", methods=["POST"])
def compare():
    """Compare naive route against optimized route and return efficiency gain."""
    try:
        payload = request.get_json(force=True) or {}
        validation_error = _validate_route_request(payload)
        if validation_error:
            return jsonify({"error": validation_error}), 400
        result = _run_optimization(payload)

        return jsonify(
            {
                "naive_route": result["naive_route"],
                "naive_distance": result["naive_distance"],
                "optimized_route": result["optimized_route"],
                "optimized_distance": result["total_distance"],
                "efficiency_improvement_percent": result["improvement_percent"],
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/optimize_route", methods=["POST"])
def optimize_route():
    """Professional optimization endpoint with extended response payload."""
    try:
        payload = request.get_json(force=True) or {}
        validation_error = _validate_route_request(payload)
        if validation_error:
            return jsonify({"error": validation_error}), 400
        return jsonify(_run_optimization(payload))
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


if __name__ == "__main__":
    app.run(debug=True, port=5000)

