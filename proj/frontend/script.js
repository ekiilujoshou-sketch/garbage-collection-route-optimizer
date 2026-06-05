const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:5000"
  : window.location.origin;
let map;
let bins = [];
let priorityBins = new Set();
let markers = {};
let polylines = [];
let binCounter = 65; // 'A'

// Navigation & Simulation State
let lastOsrmRoute = null;
let navigationActive = false;
let simulationInterval = null;
let simulationPaused = false;
let vehicleMarker = null;
let navigationCues = [];
let watchId = null;
let binsInRouteOrder = [];
let currentPathPoints = [];
let currentPathIndex = 0;

document.addEventListener("DOMContentLoaded", () => {
  // Splash screen logic
  const splashScreen = document.getElementById("splash-screen");
  const openRouteBtn = document.getElementById("open-route-btn");
  openRouteBtn.addEventListener("click", () => {
    splashScreen.classList.add("hidden");
  });

  // Use Geolocation to center map, fallback to New Delhi
  const defaultCoords = [28.6139, 77.2090];
  map = L.map('map', { zoomControl: false }).setView(defaultCoords, 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 19
  }).addTo(map);

  // Try to locate user
  map.locate({ setView: true, maxZoom: 14 });
  map.on('locationfound', (e) => {
    updateStatus("Location found. Click map to add bins.");
  });
  map.on('locationerror', (e) => {
    updateStatus("Location not available. Using default map. Click map to add bins.");
  });

  map.on('click', onMapClick);

  // Prevent clicks on the panel from passing through to the map
  const panel = document.querySelector('.uber-panel');
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);

  document.getElementById("route-btn").addEventListener("click", generateRoute);
  document.getElementById("clear-btn").addEventListener("click", clearAll);

  // Navigation event listeners
  document.getElementById("nav-start-btn").addEventListener("click", startNavigation);
  document.getElementById("nav-stop-btn").addEventListener("click", stopNavigation);

  // Mobile bottom-sheet expand/collapse toggle
  const mobileHandle = document.querySelector(".mobile-handle");
  const pnl = document.querySelector(".uber-panel");
  if (mobileHandle && pnl) {
    const togglePanel = () => {
      if (window.innerWidth <= 768) {
        pnl.classList.toggle("expanded");
        
        // Dynamically adjust Leaflet zoom controls so they don't get covered
        const zoomControl = document.querySelector(".leaflet-bottom.leaflet-right");
        if (zoomControl) {
          if (pnl.classList.contains("expanded")) {
            zoomControl.style.setProperty("bottom", "87vh", "important");
          } else {
            zoomControl.style.setProperty("bottom", "47vh", "important");
          }
        }
      }
    };
    mobileHandle.addEventListener("click", togglePanel);
    
    // Also allow clicking the header h1 to toggle on mobile
    const header = pnl.querySelector("h1");
    if (header) {
      header.addEventListener("click", togglePanel);
      header.style.cursor = "pointer";
    }
  }
});

function onMapClick(e) {
  const isPriority = document.getElementById("priority-mode").checked;
  const id = String.fromCharCode(binCounter++);

  const bin = { id, lat: e.latlng.lat, lng: e.latlng.lng };
  bins.push(bin);
  if (isPriority) priorityBins.add(id);

  addMarker(bin, isPriority);
  refreshNodeSelectors();
  updateStatus(`Added bin ${id}`);
}

function addMarker(bin, isPriority) {
  let className = "custom-marker";
  if (isPriority) className += " priority";

  const icon = L.divIcon({
    className: className,
    html: `<span>${bin.id}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  const marker = L.marker([bin.lat, bin.lng], { icon }).addTo(map);
  marker.bindPopup(`Bin ${bin.id} ${isPriority ? '(Priority)' : ''}`);
  markers[bin.id] = marker;
}

function refreshNodeSelectors() {
  const startSelect = document.getElementById("start-node");
  const endSelect = document.getElementById("end-node");

  const oldStart = startSelect.value;
  const oldEnd = endSelect.value;

  const options = bins.map(b => `<option value="${b.id}">Bin ${b.id}</option>`).join("");
  startSelect.innerHTML = options;
  endSelect.innerHTML = `<option value="">(none)</option>${options}`;

  if (oldStart && bins.some(b => b.id === oldStart)) {
    startSelect.value = oldStart;
  } else if (bins.length > 0) {
    startSelect.value = bins[0].id;
  }

  if (oldEnd && bins.some(b => b.id === oldEnd)) {
    endSelect.value = oldEnd;
  }
}

function updateStatus(msg) {
  document.getElementById("status-text").innerText = msg;
}

function clearMapLayers() {
  polylines.forEach(p => map.removeLayer(p));
  polylines = [];
}

function clearAll() {
  stopNavigation();
  document.getElementById("nav-controls").style.display = "none";
  clearMapLayers();
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  bins = [];
  priorityBins.clear();
  binCounter = 65;
  refreshNodeSelectors();
  document.getElementById("output-box").innerHTML = "";
  updateStatus("Map cleared. Click to add bins.");
}

async function generateRoute() {
  if (bins.length < 2) {
    updateStatus("Need at least 2 bins to route.");
    return;
  }
  const start = document.getElementById("start-node").value;
  const end = document.getElementById("end-node").value;
  const method = "tsp_approx";

  updateStatus("Calculating route...");

  try {
    await fetch(`${API_BASE}/add_nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: bins })
    });

    const res = await fetch(`${API_BASE}/compute_route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start,
        end: end || undefined,
        method,
        priority_bins: Array.from(priorityBins)
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to compute");
    }

    const data = await res.json();
    drawRoutes(data);
    updateStatus("Route generated successfully.");
  } catch (err) {
    updateStatus(`Error: ${err.message}`);
  }
}

const truckColors = ["#000000", "#2563eb", "#ea580c", "#16a34a", "#9333ea"];

let totalRoadDistance = 0;
let totalRoadTime = 0;

function drawRoutes(data) {
  clearMapLayers();

  const route = data.route;

  totalRoadDistance = 0;
  totalRoadTime = 0;
  let completedRequests = 0;

  // Show initial loading state for metrics
  document.getElementById("output-box").innerHTML = `
    <div class="status-bar" style="background:#e0f2fe; color:#0369a1;">
      Fetching road directions...
    </div>
  `;

  const latlngs = route.map(id => {
    const bin = bins.find(b => b.id === id);
    return [bin.lat, bin.lng];
  });

  const color = truckColors[0];

  if (latlngs.length < 2) {
    checkAllRequestsDone(1, 1, data);
    return;
  }

  const coordsString = latlngs.map(ll => `${ll[1]},${ll[0]}`).join(';');
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson&steps=true`;

  fetch(osrmUrl)
    .then(res => res.json())
    .then(osrmData => {
      if (osrmData.code === "Ok" && osrmData.routes && osrmData.routes[0]) {
        const routeData = osrmData.routes[0];
        const geojson = routeData.geometry;

        lastOsrmRoute = routeData;
        binsInRouteOrder = data.route;
        currentPathPoints = geojson.coordinates.map(c => [c[1], c[0]]);

        totalRoadDistance += routeData.distance; // meters
        totalRoadTime += routeData.duration; // seconds

        const polyline = L.geoJSON(geojson, {
          style: { color: color, weight: 5, opacity: 0.9 }
        }).addTo(map);
        polylines.push(polyline);

        const group = new L.featureGroup(polylines);
        map.fitBounds(group.getBounds(), { padding: [50, 50] });

        // Show navigation control panel
        document.getElementById("nav-controls").style.display = "block";
      } else {
        // Fallback to straight lines
        lastOsrmRoute = null;
        binsInRouteOrder = data.route;
        currentPathPoints = latlngs;
        drawStraightLineFallback(latlngs, color);
        document.getElementById("nav-controls").style.display = "block";
      }
    })
    .catch(err => {
      console.error("OSRM Routing Error:", err);
      drawStraightLineFallback(latlngs, color);
    })
    .finally(() => {
      checkAllRequestsDone(1, 1, data);
    });

  Object.values(markers).forEach(m => {
    L.DomUtil.removeClass(m._icon, 'start');
  });
  const startId = document.getElementById("start-node").value;
  if (markers[startId]) {
    L.DomUtil.addClass(markers[startId]._icon, 'start');
  }
}

function drawStraightLineFallback(latlngs, color) {
  const polyline = L.polyline(latlngs, {
    color: color, weight: 4, opacity: 0.8, dashArray: '10, 10'
  }).addTo(map);
  polylines.push(polyline);
  const group = new L.featureGroup(polylines);
  map.fitBounds(group.getBounds(), { padding: [50, 50] });
}

function checkAllRequestsDone(completed, total, data) {
  if (completed === total) {
    displayOutput(data);
  }
}

function displayOutput(data) {
  const box = document.getElementById("output-box");

  let distKm = data.total_distance;
  let timeStr = data.metrics.optimized_time_estimate_hhmmss || 'N/A';
  let fuel = data.metrics.fuel_estimate || '0';

  if (totalRoadDistance > 0) {
    distKm = totalRoadDistance / 1000;
    fuel = (distKm * 0.5).toFixed(2);
  }

  if (totalRoadTime > 0) {
    // Includes 5 mins stop time per bin for collection
    const totalTimeWithStops = totalRoadTime + (data.route.length * 5 * 60);
    const h = Math.floor(totalTimeWithStops / 3600);
    const m = Math.floor((totalTimeWithStops % 3600) / 60);
    const s = Math.floor(totalTimeWithStops % 60);
    timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  box.innerHTML = `
    <div class="metric-card">
      <div class="title">ROAD DISTANCE</div>
      <div class="val">${distKm.toFixed(2)} km</div>
    </div>
    <div class="metric-card">
      <div class="title">EST TIME (INC. STOPS)</div>
      <div class="val">${timeStr}</div>
    </div>
    <div class="metric-card">
      <div class="title">FUEL ESTIMATE</div>
      <div class="val">${fuel} Liters</div>
    </div>
    <div style="font-size: 13px; color: #6b7280; margin-top: 5px;">
      <b>Route:</b> ${data.route.join(" → ")}
    </div>
  `;
}

// ==========================================
// Navigation & Voice Assistant Engine
// ==========================================

function speakText(text) {
  const voiceEnabled = document.getElementById("voice-toggle").checked;
  if (!voiceEnabled) return;

  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0; // natural reading speed

    // Pause simulation while speaking so vehicle doesn't speed past cues
    utterance.onstart = () => {
      if (navigationActive) {
        simulationPaused = true;
      }
    };

    utterance.onend = () => {
      if (navigationActive) {
        // Only resume if we are not currently doing waste collection at a bin (icon 🗑️)
        const icon = document.getElementById("nav-hud-icon").innerText;
        if (icon !== "🗑️") {
          simulationPaused = false;
        }
      }
    };

    utterance.onerror = () => {
      if (navigationActive) {
        const icon = document.getElementById("nav-hud-icon").innerText;
        if (icon !== "🗑️") {
          simulationPaused = false;
        }
      }
    };

    window.speechSynthesis.speak(utterance);
  }
}

function updateHUD(instruction, subtext) {
  document.getElementById("nav-hud-instruction").innerText = instruction;
  if (subtext !== undefined) {
    document.getElementById("nav-hud-subtext").innerText = subtext;
  }
}

function updateHUDSubtext(subtext) {
  document.getElementById("nav-hud-subtext").innerText = subtext;
}

function getHeading(fromLatLng, toLatLng) {
  const dy = toLatLng[0] - fromLatLng[0];
  const dx = Math.cos(Math.PI / 180 * fromLatLng[0]) * (toLatLng[1] - fromLatLng[1]);
  const angle = Math.atan2(dx, dy) * 180 / Math.PI;
  return angle;
}

function getDistanceMeters(p1, p2) {
  const R = 6371000;
  const dLat = (p2[0] - p1[0]) * Math.PI / 180;
  const dLng = (p2[1] - p1[1]) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1[0] * Math.PI / 180) * Math.cos(p2[0] * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function interpolatePoints(points, stepSizeMeters = 5) {
  const interpolated = [];
  if (points.length < 2) return points;

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const d = getDistanceMeters(p1, p2);
    interpolated.push(p1);

    if (d > stepSizeMeters) {
      const steps = Math.floor(d / stepSizeMeters);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const lat = p1[0] + (p2[0] - p1[0]) * t;
        const lng = p1[1] + (p2[1] - p1[1]) * t;
        interpolated.push([lat, lng]);
      }
    }
  }
  interpolated.push(points[points.length - 1]);
  return interpolated;
}

function getManeuverInstruction(step, nextStepName) {
  const type = step.maneuver.type;
  const modifier = step.maneuver.modifier;
  const roadName = step.name || nextStepName || "";

  if (type === "depart") {
    return `Head toward ${roadName || "the route path"}`;
  }
  if (type === "arrive") {
    return `You have arrived at the destination`;
  }

  let action = "";
  switch (modifier) {
    case "left":
      action = "turn left";
      break;
    case "right":
      action = "turn right";
      break;
    case "sharp left":
      action = "take a sharp left";
      break;
    case "sharp right":
      action = "take a sharp right";
      break;
    case "slight left":
      action = "bear left";
      break;
    case "slight right":
      action = "bear right";
      break;
    case "uturn":
      action = "make a U-turn";
      break;
    case "straight":
      action = "continue straight";
      break;
    default:
      action = "continue";
  }

  if (roadName) {
    return `${action} onto ${roadName}`;
  } else {
    return `${action}`;
  }
}

function compileNavigationCues() {
  navigationCues = [];

  if (!lastOsrmRoute) {
    // If fallback is active (straight lines between bins)
    binsInRouteOrder.forEach((binId, index) => {
      const bin = bins.find(b => b.id === binId);
      if (!bin) return;
      if (index === 0) {
        navigationCues.push({
          latlng: [bin.lat, bin.lng],
          instruction: `Starting route at Bin ${binId}. Proceed to next collection point.`,
          type: "depart",
          spokenExact: false,
          spokenWarning: true
        });
      } else {
        navigationCues.push({
          latlng: [bin.lat, bin.lng],
          instruction: `Arrived at Bin ${binId}. Performing waste collection.`,
          type: "arrive_bin",
          binId: binId,
          spokenExact: false,
          spokenWarning: true
        });
      }
    });
    return;
  }

  const legs = lastOsrmRoute.legs;
  if (!legs) return;

  legs.forEach((leg, legIndex) => {
    const nextBinId = binsInRouteOrder[legIndex + 1];

    // Add start of leg cue
    if (legIndex === 0) {
      const startBin = bins.find(b => b.id === binsInRouteOrder[0]);
      navigationCues.push({
        latlng: startBin ? [startBin.lat, startBin.lng] : currentPathPoints[0],
        instruction: `Starting route. Proceed to waste collection point, Bin ${nextBinId}`,
        type: "depart",
        spokenExact: false,
        spokenWarning: true
      });
    }

    if (leg.steps) {
      leg.steps.forEach((step, stepIndex) => {
        if (stepIndex === 0) return; // Skip redundant first step

        const coords = step.maneuver.location;
        const latlng = [coords[1], coords[0]];
        const nextStepName = leg.steps[stepIndex + 1]?.name;
        const instruction = getManeuverInstruction(step, nextStepName);

        navigationCues.push({
          latlng: latlng,
          instruction: instruction,
          type: step.maneuver.type,
          distance: step.distance,
          spokenWarning: false,
          spokenExact: false
        });
      });
    }

    // Add arrival at bin cue
    if (nextBinId) {
      const destBin = bins.find(b => b.id === nextBinId);
      if (destBin) {
        navigationCues.push({
          latlng: [destBin.lat, destBin.lng],
          instruction: `Arrived at Bin ${nextBinId}. Performing waste collection.`,
          type: "arrive_bin",
          binId: nextBinId,
          spokenExact: false,
          spokenWarning: true
        });
      }
    }
  });
}

function startNavigation() {
  if (navigationActive) return;

  if (!currentPathPoints || currentPathPoints.length === 0) {
    updateStatus("Please calculate a route first.");
    return;
  }

  navigationActive = true;
  document.getElementById("nav-start-btn").style.display = "none";
  document.getElementById("nav-stop-btn").style.display = "block";

  // Show HUD
  const hud = document.getElementById("nav-hud");
  hud.classList.remove("hidden");
  document.getElementById("nav-hud-icon").innerText = "🧭";

  // Disable configuration options to prevent disruptions
  document.getElementById("route-btn").disabled = true;
  document.getElementById("clear-btn").disabled = true;

  // Compile cues
  compileNavigationCues();

  const mode = document.getElementById("nav-mode").value;

  if (document.getElementById("follow-vehicle").checked && currentPathPoints.length > 0) {
    map.setView(currentPathPoints[0], 17);
  }

  if (mode === "simulation") {
    startSimulation();
  } else {
    startLiveTracking();
  }
}

function stopNavigation() {
  navigationActive = false;

  // Hide HUD
  const hud = document.getElementById("nav-hud");
  if (hud) hud.classList.add("hidden");
  const spinner = document.getElementById("nav-hud-spinner");
  if (spinner) spinner.style.display = "none";

  // Stop simulation
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  simulationPaused = false;

  // Stop GPS tracking
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  // Clean up vehicle marker
  if (vehicleMarker) {
    map.removeLayer(vehicleMarker);
    vehicleMarker = null;
  }

  // Reset buttons
  const startBtn = document.getElementById("nav-start-btn");
  if (startBtn) startBtn.style.display = "block";
  const stopBtn = document.getElementById("nav-stop-btn");
  if (stopBtn) stopBtn.style.display = "none";

  const routeBtn = document.getElementById("route-btn");
  if (routeBtn) routeBtn.disabled = false;
  const clearBtn = document.getElementById("clear-btn");
  if (clearBtn) clearBtn.disabled = false;

  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }

  updateStatus("Navigation stopped.");
}

function startSimulation() {
  currentPathIndex = 0;
  simulationPaused = false;

  const stepSizeMeters = 2.5; // slow down base speed (2.5 meters per tick = ~45km/h)
  const interpolatedPath = interpolatePoints(currentPathPoints, stepSizeMeters);

  speakText("Starting route simulation. Navigation active.");
  updateHUD("Route Simulation Started", "Calculating pathway...");

  simulationInterval = setInterval(() => {
    if (simulationPaused) return;

    if (currentPathIndex >= interpolatedPath.length) {
      clearInterval(simulationInterval);
      simulationInterval = null;
      speakText("Route completed. All waste collected. Returning to base.");
      updateHUD("Route Completed", "All bins successfully serviced.");
      setTimeout(() => {
        stopNavigation();
      }, 5000);
      return;
    }

    const currentPos = interpolatedPath[currentPathIndex];
    const nextPos = interpolatedPath[currentPathIndex + 1] || currentPos;
    const heading = getHeading(currentPos, nextPos);

    updateVehicleMarker(currentPos, heading);
    processCuesForPosition(currentPos);

    const totalRemaining = calculateTripRemainingDistance(interpolatedPath, currentPathIndex);
    const timeRemainingSeconds = Math.round(totalRemaining / stepSizeMeters);
    const timeStr = formatRemainingTime(timeRemainingSeconds);
    updateHUDSubtext(`${(totalRemaining / 1000).toFixed(2)} km remaining • ${timeStr}`);

    currentPathIndex++;
  }, 200);
}

function startLiveTracking() {
  if (!("geolocation" in navigator)) {
    updateStatus("Geolocation is not supported by your device.");
    stopNavigation();
    return;
  }

  speakText("Starting live tracking mode. Waiting for GPS signal.");
  updateHUD("Acquiring GPS...", "Make sure location permissions are enabled.");

  let lastGpsPos = null;

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const currentPos = [lat, lng];

      let heading = position.coords.heading;
      if (heading === null && lastGpsPos) {
        heading = getHeading(lastGpsPos, currentPos);
      }
      lastGpsPos = currentPos;

      updateVehicleMarker(currentPos, heading || 0);
      processCuesForPosition(currentPos);

      const nextCue = navigationCues.find(c => !c.spokenExact);
      if (nextCue) {
        const distToCue = getDistanceMeters(currentPos, nextCue.latlng);
        updateHUDSubtext(`Next point: ${(distToCue).toFixed(0)} meters away`);
      } else {
        updateHUDSubtext("All points visited");
      }
    },
    (err) => {
      console.error("GPS Watch Error:", err);
      updateStatus(`GPS Error: ${err.message}`);
      speakText("GPS signal error.");
      updateHUD("GPS Error", err.message);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    }
  );
}

function processCuesForPosition(currentPos) {
  for (let i = 0; i < navigationCues.length; i++) {
    const cue = navigationCues[i];
    const dist = getDistanceMeters(currentPos, cue.latlng);

    if (cue.type === "arrive_bin") {
      if (dist <= 15 && !cue.spokenExact) {
        cue.spokenExact = true;
        simulationPaused = true;

        speakText(cue.instruction);
        updateHUD(`Arrived at Bin ${cue.binId}`, "Waste collection in progress...");
        document.getElementById("nav-hud-spinner").style.display = "block";
        document.getElementById("nav-hud-icon").innerText = "🗑️";

        setTimeout(() => {
          if (!navigationActive) return;
          speakText("Waste collected. Proceeding to next destination.");
          updateHUD("Route Resumed", "Heading to next point...");
          document.getElementById("nav-hud-spinner").style.display = "none";
          document.getElementById("nav-hud-icon").innerText = "🧭";
          simulationPaused = false;
        }, 4000);
        break;
      }
    } else {
      if (dist <= 50 && dist > 15 && !cue.spokenWarning) {
        cue.spokenWarning = true;
        speakText(`In 40 meters, ${cue.instruction}`);
        updateHUD(cue.instruction, `In 40 meters`);
      }

      if (dist <= 15 && !cue.spokenExact) {
        cue.spokenExact = true;
        speakText(cue.instruction);
        updateHUD(cue.instruction, `Now`);
      }
    }
  }
}

function updateVehicleMarker(latlng, heading) {
  const angle = heading || 0;
  const iconHtml = `
    <div class="vehicle-marker-container" style="transform: rotate(${angle}deg);">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M16 4L6 26L16 21L26 26L16 4Z" fill="#2563eb" stroke="white" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    </div>
  `;

  const icon = L.divIcon({
    className: 'vehicle-marker',
    html: iconHtml,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });

  if (!vehicleMarker) {
    vehicleMarker = L.marker(latlng, { icon }).addTo(map);
  } else {
    vehicleMarker.setLatLng(latlng);
    vehicleMarker.setIcon(icon);
  }

  if (document.getElementById("follow-vehicle").checked) {
    map.panTo(latlng);
  }
}

function calculateTripRemainingDistance(path, startIndex) {
  let dist = 0;
  for (let i = startIndex; i < path.length - 1; i++) {
    dist += getDistanceMeters(path[i], path[i + 1]);
  }
  return dist;
}

function formatRemainingTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}
