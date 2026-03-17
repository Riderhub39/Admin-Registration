// live-tracking-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";
import { showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

// ==========================================
// 全局变量定义
// ==========================================
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const rtdb = getDatabase(app); 
const auth = getAuth(app);

const STORE_LOCATION = { lat: 4.5975, lng: 101.0901 }; 
const STORE_RADIUS_METERS = 500; 

let map, currentMarker, storeCircle, startMarker; 
let routePolylines = []; 
let usersMap = {}; 
let lastKnownPosition = null;

let unsubscribeListListener = null;
let unsubscribeStaffListener = null;

// 🟢 轨迹回放全局状态
window.isReplaying = false;
window.replayInterval = null;
window.currentRouteLogs = [];

// ==========================================
// 1. 初始化入口
// ==========================================
export async function initLiveTrackingApp() {
    showLoading();
    document.getElementById('loadingText').innerText = "Initializing Tracking...";
    
    await fetchUsers(); 

    if (typeof google !== 'undefined' && google.maps) {
        setupMapAndUI();
    } else {
        window.initMap = () => setupMapAndUI();
    }
}

function setupMapAndUI() {
    if(typeof google === 'undefined' || !google.maps) {
        hideLoading();
        showStatusAlert('statusMessage', 'Google Maps failed to load.', false);
        return;
    }

    map = new google.maps.Map(document.getElementById("map"), {
        center: STORE_LOCATION,
        zoom: 12,
        disableDefaultUI: false,
        styles: [ { "featureType": "poi", "stylers": [{ "visibility": "off" }] } ]
    });

    storeCircle = new google.maps.Circle({
        strokeColor: "#F59E0B", strokeOpacity: 0.8, strokeWeight: 2,
        fillColor: "#F59E0B", fillOpacity: 0.1,
        map: map, center: STORE_LOCATION, radius: STORE_RADIUS_METERS,
    });

    const datePicker = document.getElementById('datePicker');
    datePicker.value = new Date().toLocaleDateString('en-CA');
    
    loadDriverListForSelectedDate();

    datePicker.addEventListener('change', () => {
        loadDriverListForSelectedDate();
        resetMapView();
    });

    document.getElementById('searchInput').addEventListener('keyup', (e) => {
        const term = e.target.value.toLowerCase();
        document.querySelectorAll('.user-item').forEach(item => {
            item.style.display = item.getAttribute('data-name').toLowerCase().includes(term) ? 'block' : 'none';
        });
    });

    hideLoading();
    document.getElementById('mainContainer').classList.remove('d-none');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function resetMapView() {
    if(unsubscribeStaffListener) { 
        unsubscribeStaffListener(); 
        unsubscribeStaffListener = null; 
    }
    
    if(currentMarker) {
        currentMarker.setMap(null);
        currentMarker = null; 
    }

    if(startMarker) {
        startMarker.setMap(null);
        startMarker = null;
    }
    
    if(routePolylines && routePolylines.length > 0) {
        routePolylines.forEach(p => p.setMap(null));
        routePolylines = [];
    }
    
    if(window.replayInterval) {
        clearInterval(window.replayInterval);
        window.replayInterval = null;
        window.isReplaying = false;
        const btn = document.getElementById('replayBtn');
        if(btn) {
            btn.classList.replace('btn-danger', 'btn-outline-primary');
            btn.innerHTML = '<i data-lucide="play" class="size-4 me-2"></i> Route Replay';
        }
    }
    document.getElementById('replayBtn').classList.add('d-none');
    window.currentRouteLogs = [];

    document.getElementById('statusOverlay').classList.add('d-none');
    window.selectedUid = null;
    lastKnownPosition = null;
}

// ==========================================
// 2. 数据获取逻辑
// ==========================================
async function fetchUsers() {
    try {
        const snap = await getDocs(collection(db, "users"));
        usersMap = {}; 
        snap.forEach(doc => {
            const d = doc.data();
            const displayName = d.personal?.shortName || d.personal?.name || d.name || "Staff";
            usersMap[doc.id] = displayName;
            if (d.authUid) {
                usersMap[d.authUid] = displayName;
            }
        });
    } catch (e) { 
        console.error("Error fetching users:", e); 
    }
}

async function loadDriverListForSelectedDate() {
    if(unsubscribeListListener) { 
        unsubscribeListListener(); 
        unsubscribeListListener = null; 
    }

    const dateStr = document.getElementById('datePicker').value;
    const todayStr = new Date().toLocaleDateString('en-CA');
    const listDiv = document.getElementById('driverList');
    listDiv.innerHTML = '<div class="text-center text-muted small py-4">Syncing...</div>';

    if (dateStr === todayStr) {
        const liveRef = ref(rtdb, 'live_locations');
        unsubscribeListListener = onValue(liveRef, (snapshot) => {
            const data = snapshot.val();
            
            if (!data) {
                listDiv.innerHTML = '<div class="text-center text-muted small py-4">No active drivers today.</div>';
                return;
            }

            let html = '';
            Object.entries(data).forEach(([uid, val]) => {
                const lastUpdate = new Date(val.lastUpdate);
                const updateDateStr = lastUpdate.toLocaleDateString('en-CA');
                if (updateDateStr !== todayStr) return; 

                const realName = usersMap[uid] || `User (${uid.substring(0, 5)})`;
                
                const diffMins = (new Date() - lastUpdate) / 60000;
                let statusBadge = '';
                
                if (val.isTracking === false || diffMins >= 15) {
                    statusBadge = '<span class="badge bg-secondary bg-opacity-10 text-secondary border" style="font-size:10px">Offline / Lost</span>';
                } else if (diffMins >= 5) {
                    statusBadge = '<div class="d-flex align-items-center gap-1"><span class="status-dot-custom bg-warning"></span> <small class="text-warning fw-bold" style="font-size:10px">Weak Signal</small></div>';
                } else {
                    statusBadge = '<div class="d-flex align-items-center gap-1"><span class="status-dot-custom bg-success"></span> <small class="text-success fw-bold" style="font-size:10px">Active</small></div>';
                }

                html += buildUserListItem(uid, realName, lastUpdate.toLocaleTimeString(), statusBadge);
            });

            if (html === '') {
                listDiv.innerHTML = '<div class="text-center text-muted small py-4">No active drivers today.</div>';
            } else {
                listDiv.innerHTML = html;
            }
            if (typeof lucide !== 'undefined') lucide.createIcons();
        });
    } else {
        try {
            const snap = await getDocs(query(collection(db, "tracking_batches"), where("date", "==", dateStr)));
            const users = new Set();
            snap.forEach(d => users.add(d.data().uid));

            if (users.size === 0) {
                listDiv.innerHTML = '<div class="text-center text-muted small py-4">No tracking records.</div>';
                return;
            }

            let html = '';
            users.forEach(uid => {
                const realName = usersMap[uid] || `Staff (${uid.substring(0, 5)})`;
                html += buildUserListItem(uid, realName, "Archived Data", '<span class="badge bg-light text-secondary border" style="font-size:10px">History</span>');
            });
            listDiv.innerHTML = html;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        } catch(e) {
            listDiv.innerHTML = '<div class="text-center text-danger small py-4">Error loading history.</div>';
        }
    }
}

function buildUserListItem(uid, realName, timeText, badge) {
    return `<div class="user-item p-3" id="user-${uid}" data-name="${realName}" onclick="window.viewStaffRoute('${uid}', '${realName}')">
        <div class="d-flex align-items-center gap-3">
            <div class="avatar-placeholder bg-primary bg-opacity-10 text-primary small">${realName.substring(0, 2).toUpperCase()}</div>
            <div class="flex-grow-1 overflow-hidden">
                <div class="fw-bold text-dark text-truncate">${realName}</div>
                <div class="small text-muted"><i data-lucide="clock" class="size-3"></i> ${timeText}</div>
            </div>
            ${badge}
        </div>
    </div>`;
}

// ==========================================
// 3. 路线与标点展示
// ==========================================
window.viewStaffRoute = async function(uid, realName) {
    resetMapView();
    window.selectedUid = uid;
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`user-${uid}`)?.classList.add('active');
    document.getElementById('statusOverlay').classList.remove('d-none');
    document.getElementById('overlayName').innerText = realName;

    const dateStr = document.getElementById('datePicker').value;
    const todayStr = new Date().toLocaleDateString('en-CA');

    if (dateStr === todayStr) {
        const singleRef = ref(rtdb, `live_locations/${uid}`);
        unsubscribeStaffListener = onValue(singleRef, (snapshot) => {
            const val = snapshot.val();
            if (val && window.selectedUid === uid && !window.isReplaying) {
                updateCarMarker(val, realName, false);
            }
        });
    }

    try {
        const snap = await getDocs(query(collection(db, "tracking_batches"), where("uid", "==", uid), where("date", "==", dateStr)));
        let allPoints = [];
        const batches = snap.docs.map(d => d.data());
        batches.sort((a, b) => (a.uploadedAt?.seconds || 0) - (b.uploadedAt?.seconds || 0));

        batches.forEach(b => {
            if (b.points) {
                b.points.forEach(p => allPoints.push({ lat: p.lat, lng: p.lng, timestamp: p.ts }));
            }
        });

        if (allPoints.length > 0) {
            drawRoute(allPoints, realName);
        } else if (dateStr !== todayStr) {
            showNoRecordState();
        }

        setTimeout(() => { if(lastKnownPosition && !window.isReplaying) window.focusOnDriver(); }, 600);
    } catch (e) { console.error(e); }
};

function showNoRecordState() {
    document.getElementById('overlaySpeed').innerText = "0";
    document.getElementById('overlayTime').innerText = "No Data";
    document.getElementById('overlayStatusTag').innerText = "No Record";
    document.getElementById('overlayStatusTag').className = "badge bg-secondary";
}

// 🟢 全新重写：多重数据清洗与抗绕路引擎
async function drawRoute(rawLogs, realName) {
    if(routePolylines.length > 0) {
        routePolylines.forEach(p => p.setMap(null));
        routePolylines = [];
    }

    if (rawLogs.length === 0) return;

    // --- 第一阶：基础清洗 (距离与异常速度) ---
    let tempLogs = [];
    tempLogs.push(rawLogs[0]); 
    let lastValidPoint = rawLogs[0];

    for (let i = 1; i < rawLogs.length; i++) {
        let currentPoint = rawLogs[i];
        
        let p1 = new google.maps.LatLng(lastValidPoint.lat, lastValidPoint.lng);
        let p2 = new google.maps.LatLng(currentPoint.lat, currentPoint.lng);
        let distanceMeters = google.maps.geometry.spherical.computeDistanceBetween(p1, p2);

        if (distanceMeters < 30) continue; // 原地微小抖动

        let timeDiffSeconds = Math.abs(currentPoint.timestamp - lastValidPoint.timestamp) / 1000; 
        if (timeDiffSeconds <= 0) continue; 

        let speedMetersPerSecond = distanceMeters / timeDiffSeconds;
        if (speedMetersPerSecond > 33.33) continue; // 超人瞬移拦截 (120km/h)

        tempLogs.push(currentPoint);
        lastValidPoint = currentPoint;
    }

    // --- 第二阶：高级防飞点三角拦截 (Ping-Pong Filter) ---
    let logs = [];
    if (tempLogs.length > 2) {
        for (let i = 0; i < tempLogs.length; i++) {
            if (i === 0 || i === tempLogs.length - 1) {
                logs.push(tempLogs[i]);
                continue;
            }
            let prev = tempLogs[i - 1];
            let curr = tempLogs[i];
            let next = tempLogs[i + 1];

            let distPrevCurr = google.maps.geometry.spherical.computeDistanceBetween(new google.maps.LatLng(prev.lat, prev.lng), new google.maps.LatLng(curr.lat, curr.lng));
            let distCurrNext = google.maps.geometry.spherical.computeDistanceBetween(new google.maps.LatLng(curr.lat, curr.lng), new google.maps.LatLng(next.lat, next.lng));
            let distPrevNext = google.maps.geometry.spherical.computeDistanceBetween(new google.maps.LatLng(prev.lat, prev.lng), new google.maps.LatLng(next.lat, next.lng));

            // 如果当前点突然飞远(与前后距离都>100m)，但是前后两个点其实很近(比如不到飞出距离的一半)，这就是纯漂移！
            if (distPrevCurr > 100 && distCurrNext > 100 && distPrevNext < distPrevCurr * 0.5) {
                console.warn("Spike removed:", curr);
                continue; 
            }
            logs.push(curr);
        }
    } else {
        logs = tempLogs;
    }

    if (logs.length < 2) {
        document.getElementById('replayBtn').classList.add('d-none');
        return; 
    }

    window.currentRouteLogs = logs;
    document.getElementById('replayBtn').classList.remove('d-none');

    // 起点
    const firstLog = logs[0];
    if (!startMarker) {
        startMarker = new google.maps.Marker({
            position: { lat: firstLog.lat, lng: firstLog.lng },
            map: map,
            title: "Start Point",
            label: { text: "起", color: "white", fontSize: "12px", fontWeight: "bold" },
            icon: { 
                path: google.maps.SymbolPath.CIRCLE, 
                scale: 12, 
                fillColor: "#10b981", 
                fillOpacity: 1, 
                strokeWeight: 2, 
                strokeColor: "white" 
            },
            zIndex: 100 
        });
    }

    const lastLog = logs[logs.length - 1];
    const isToday = document.getElementById('datePicker').value === new Date().toLocaleDateString('en-CA');
    
    if(!isToday) {
       updateCarMarker({
           lat: lastLog.lat, 
           lng: lastLog.lng,
           lastUpdate: lastLog.timestamp,
           speed: 0
       }, realName, false);
    }

    const directionsService = new google.maps.DirectionsService();
    const MAX_WAYPOINTS = 23; 
    const CHUNK_SIZE = MAX_WAYPOINTS + 2; 

    const lineSymbol = {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 2.5,
        strokeColor: "#ffffff", 
        strokeOpacity: 1,
        fillColor: "#ffffff",
        fillOpacity: 1
    };

    let promises = [];

    for (let i = 0; i < logs.length - 1; i += CHUNK_SIZE - 1) {
        let chunk = logs.slice(i, i + CHUNK_SIZE);
        if (chunk.length < 2) continue;

        let origin = new google.maps.LatLng(chunk[0].lat, chunk[0].lng);
        let destinationFixed = new google.maps.LatLng(chunk[chunk.length - 1].lat, chunk[chunk.length - 1].lng);

        let waypoints = [];
        for (let j = 1; j < chunk.length - 1; j++) {
            waypoints.push({
                location: new google.maps.LatLng(chunk[j].lat, chunk[j].lng),
                stopover: false 
            });
        }

        let request = {
            origin: origin,
            destination: destinationFixed,
            waypoints: waypoints,
            travelMode: google.maps.TravelMode.DRIVING
        };

        let p = new Promise((resolve) => {
            directionsService.route(request, (result, status) => {
                let currentPath, color, weight;

                if (status === google.maps.DirectionsStatus.OK) {
                    // --- 第三阶：抗 API 绕路/强制掉头计算引擎 ---
                    let straightDist = google.maps.geometry.spherical.computeDistanceBetween(origin, destinationFixed);
                    
                    let routeDist = 0;
                    result.routes[0].legs.forEach(leg => { routeDist += leg.distance.value; });

                    // 如果 API 规划的距离比直线距离长 2.5 倍，且总绕路距离超过 300 米，立刻判定为 Bug 绕路！
                    if (straightDist > 0 && (routeDist / straightDist > 2.5) && routeDist > 300) {
                        console.warn(`[Anti-Detour] Blocked huge detour. Straight: ${straightDist.toFixed(0)}m, Route: ${routeDist}m. Fallback applied.`);
                        // 强制降级：直接画连线，无视道路
                        currentPath = chunk.map(c => new google.maps.LatLng(c.lat, c.lng));
                        color = "#64748b"; // 使用灰蓝色区分降级路段
                        weight = 4;
                    } else {
                        currentPath = result.routes[0].overview_path;
                        color = "#2563eb"; 
                        weight = 5;
                    }
                } else {
                    currentPath = chunk.map(c => new google.maps.LatLng(c.lat, c.lng));
                    color = "#64748b"; 
                    weight = 4;
                }

                let polyline = new google.maps.Polyline({
                    path: currentPath,
                    geodesic: true,
                    strokeColor: color,
                    strokeOpacity: 0.8,
                    strokeWeight: weight,
                    icons: [{
                        icon: lineSymbol,
                        offset: "20px",
                        repeat: "100px" 
                    }],
                    map: map
                });
                routePolylines.push(polyline);
                
                resolve();
            });
        });
        
        promises.push(p);
        await new Promise(r => setTimeout(r, 150)); 
    }

    await Promise.all(promises);
}

function updateStatusCard(lastLog) {
    const lastLatLng = new google.maps.LatLng(lastLog.lat, lastLog.lng);
    const dist = google.maps.geometry.spherical.computeDistanceBetween(lastLatLng, new google.maps.LatLng(STORE_LOCATION.lat, STORE_LOCATION.lng));
    
    if (dist > STORE_RADIUS_METERS) {
        document.getElementById('overlayStatusTag').innerText = "On Field";
        document.getElementById('overlayStatusTag').className = "badge bg-primary";
    } else {
        document.getElementById('overlayStatusTag').innerText = "Near Store";
        document.getElementById('overlayStatusTag').className = "badge bg-warning text-dark";
    }
}

function updateCarMarker(data, realName, isReplayMode = false) {
    const pos = { lat: parseFloat(data.lat), lng: parseFloat(data.lng) };
    lastKnownPosition = pos; 
    
    let markerColor = "#ef4444"; 
    let markerOpacity = 1;
    let statusText = "On Field";
    let statusClass = "badge bg-primary";

    const isToday = document.getElementById('datePicker').value === new Date().toLocaleDateString('en-CA');
    
    if (isToday && !isReplayMode && data.lastUpdate) {
        const diffMins = (new Date() - new Date(data.lastUpdate)) / 60000;
        if (data.isTracking === false || diffMins >= 15) {
            markerColor = "#9ca3af"; 
            markerOpacity = 0.5; 
            statusText = "Signal Lost";
            statusClass = "badge bg-secondary";
        } else if (diffMins >= 5) {
            markerColor = "#f59e0b"; 
            statusText = "Weak Signal";
            statusClass = "badge bg-warning text-dark";
        }
    }

    if(!currentMarker) {
        currentMarker = new google.maps.Marker({
            position: pos, map: map, title: realName,
            label: { text: "终", color: "white", fontSize: "12px", fontWeight: "bold" },
            icon: { 
                path: google.maps.SymbolPath.CIRCLE, 
                scale: 12, 
                fillColor: markerColor, 
                fillOpacity: markerOpacity, 
                strokeWeight: 2, 
                strokeColor: "white" 
            },
            zIndex: 200 
        });
    } else {
        currentMarker.setIcon({
            path: google.maps.SymbolPath.CIRCLE, 
            scale: 12, 
            fillColor: markerColor, 
            fillOpacity: markerOpacity, 
            strokeWeight: 2, 
            strokeColor: "white" 
        });
        currentMarker.setPosition(pos);
        currentMarker.setMap(map); 
    }
    
    const rawSpeed = data.speed || 0;
    const finalSpeed = rawSpeed > 0 ? (rawSpeed * 3.6).toFixed(1) : 0;
    document.getElementById('overlaySpeed').innerText = finalSpeed;
    
    if (data.lastUpdate) {
        const t = new Date(data.lastUpdate);
        document.getElementById('overlayTime').innerText = t.toLocaleTimeString();
    } else {
        document.getElementById('overlayTime').innerText = '-';
    }
    
    if (isToday && !isReplayMode && (statusText === "Signal Lost" || statusText === "Weak Signal")) {
        document.getElementById('overlayStatusTag').innerText = statusText;
        document.getElementById('overlayStatusTag').className = statusClass;
    } else if (isReplayMode) {
        document.getElementById('overlayStatusTag').innerText = "Replaying";
        document.getElementById('overlayStatusTag').className = "badge bg-info text-dark";
    } else {
        updateStatusCard(data); 
    }
}

window.focusOnDriver = function() {
    if (lastKnownPosition && lastKnownPosition.lat && map) { 
        map.panTo(lastKnownPosition); 
        map.setZoom(17); 
    }
}

window.toggleRouteReplay = function() {
    const btn = document.getElementById('replayBtn');
    
    if (window.isReplaying) {
        clearInterval(window.replayInterval);
        window.isReplaying = false;
        btn.classList.replace('btn-danger', 'btn-outline-primary');
        btn.innerHTML = '<i data-lucide="play" class="size-4 me-2"></i> Route Replay';
        if (typeof lucide !== 'undefined') lucide.createIcons();
        
        const lastPoint = window.currentRouteLogs[window.currentRouteLogs.length - 1];
        if (lastPoint) {
            updateCarMarker({
                lat: lastPoint.lat,
                lng: lastPoint.lng,
                lastUpdate: lastPoint.timestamp,
                speed: 0
            }, document.getElementById('overlayName').innerText, false);
        }
        return;
    }

    if (!window.currentRouteLogs || window.currentRouteLogs.length < 2) return;

    window.isReplaying = true;
    btn.classList.replace('btn-outline-primary', 'btn-danger');
    btn.innerHTML = '<i data-lucide="square" class="size-4 me-2"></i> Stop Replay';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    
    let replayIndex = 0;
    const totalPoints = window.currentRouteLogs.length;
    const realName = document.getElementById('overlayName').innerText;

    if (map) map.setZoom(16);

    window.replayInterval = setInterval(() => {
        if (replayIndex >= totalPoints) {
            window.toggleRouteReplay(); 
            return;
        }

        const point = window.currentRouteLogs[replayIndex];
        
        let simSpeed = 0;
        if (replayIndex > 0) {
            const prev = window.currentRouteLogs[replayIndex - 1];
            const distMeters = google.maps.geometry.spherical.computeDistanceBetween(
                new google.maps.LatLng(prev.lat, prev.lng),
                new google.maps.LatLng(point.lat, point.lng)
            );
            const timeDiffSec = Math.abs(point.timestamp - prev.timestamp) / 1000;
            if (timeDiffSec > 0) {
                simSpeed = distMeters / timeDiffSec; 
            }
        }

        updateCarMarker({
            lat: point.lat,
            lng: point.lng,
            speed: simSpeed,
            lastUpdate: point.timestamp
        }, realName, true); 

        if (map) map.panTo({ lat: point.lat, lng: point.lng });

        replayIndex++;
    }, 400); 
};