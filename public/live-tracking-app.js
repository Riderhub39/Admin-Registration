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

    // 清空起点 Marker
    if(startMarker) {
        startMarker.setMap(null);
        startMarker = null;
    }
    
    // 清空所有存在的路线段
    if(routePolylines && routePolylines.length > 0) {
        routePolylines.forEach(p => p.setMap(null));
        routePolylines = [];
    }
    
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
                const isOnline = val.isTracking !== false && (new Date() - lastUpdate) < 1000 * 60 * 10;
                
                const statusBadge = isOnline 
                    ? '<div class="d-flex align-items-center gap-1"><span class="status-dot dot-online"></span> <small class="text-success" style="font-size:10px">Active</small></div>'
                    : '<span class="badge bg-secondary bg-opacity-10 text-secondary border" style="font-size:10px">Offline</span>';

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
            if (val && window.selectedUid === uid) {
                updateCarMarker(val, realName);
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

        setTimeout(() => { if(lastKnownPosition) window.focusOnDriver(); }, 600);
    } catch (e) { console.error(e); }
};

function showNoRecordState() {
    document.getElementById('overlaySpeed').innerText = "0";
    document.getElementById('overlayTime').innerText = "No Data";
    document.getElementById('overlayStatusTag').innerText = "No Record";
    document.getElementById('overlayStatusTag').className = "badge bg-secondary";
}

// ==========================================
// 全新重写：清洗毛线团、贴合道路、带方向箭头
// ==========================================
async function drawRoute(rawLogs, realName) {
    if(routePolylines.length > 0) {
        routePolylines.forEach(p => p.setMap(null));
        routePolylines = [];
    }

    if (rawLogs.length === 0) return;

    // 🧹 第一步：“防毛线团” GPS 数据清洗算法
    let logs = [];
    logs.push(rawLogs[0]); 
    let lastValidPoint = rawLogs[0];

    for (let i = 1; i < rawLogs.length; i++) {
        let currentPoint = rawLogs[i];
        
        let p1 = new google.maps.LatLng(lastValidPoint.lat, lastValidPoint.lng);
        let p2 = new google.maps.LatLng(currentPoint.lat, currentPoint.lng);
        let distanceMeters = google.maps.geometry.spherical.computeDistanceBetween(p1, p2);

        // 🛑 规则 1 (防原地抖动)：距离小于 30 米，直接忽略
        if (distanceMeters < 30) {
            continue;
        }

        // 🛑 规则 2 (防超人瞬移)：速度大于 120 km/h (约 33.33 m/s)，直接剔除
        let timeDiffSeconds = Math.abs(currentPoint.timestamp - lastValidPoint.timestamp) / 1000; 
        
        // 避免时间差为 0 导致除以 0 的错误
        if (timeDiffSeconds <= 0) {
            continue; 
        }

        let speedMetersPerSecond = distanceMeters / timeDiffSeconds;
        
        if (speedMetersPerSecond > 33.33) { // 120 km/h
            console.warn(`[剔除异常点] 速度达到 ${(speedMetersPerSecond * 3.6).toFixed(1)} km/h, 距离: ${distanceMeters.toFixed(1)}m`);
            continue;
        }

        // 通过所有检测，加入干净的数组，并更新参考点
        logs.push(currentPoint);
        lastValidPoint = currentPoint;
    }

    // 如果清洗后没剩下什么有效移动数据，直接跳出
    if (logs.length < 2) {
        console.log("清洗后无足够有效移动轨迹。");
        return; 
    }

    // 🗺️ 第二步：绘制起点标点 (绿色标点)
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
    
    // 先把历史记录的 Marker 定位好，避免等待 API 请求时界面卡顿
    if(!isToday) {
       updateCarMarker({
           lat: lastLog.lat, 
           lng: lastLog.lng,
           lastUpdate: lastLog.timestamp,
           speed: 0
       }, realName);
       updateStatusCard(lastLog);
    }

    // 🚗 第三步：实例化导航服务，绘制路线
    const directionsService = new google.maps.DirectionsService();
    const MAX_WAYPOINTS = 23; 
    const CHUNK_SIZE = MAX_WAYPOINTS + 2; 

    // 定义方向箭头样式
    const lineSymbol = {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 2.5,
        strokeColor: "#ffffff", 
        strokeOpacity: 1,
        fillColor: "#ffffff",
        fillOpacity: 1
    };

    let promises = [];

    // 将散乱的 GPS 点按照每组切块，向谷歌请求真实的马路路径
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
                    currentPath = result.routes[0].overview_path;
                    color = "#2563eb"; // 蓝色马路路线
                    weight = 5;
                } else {
                    console.warn("Snap to road failed: " + status + " -> Using fallback line.");
                    currentPath = chunk.map(c => new google.maps.LatLng(c.lat, c.lng));
                    color = "#64748b"; // 如果降级成直线，用灰蓝色
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

function updateCarMarker(data, realName) {
    const pos = { lat: parseFloat(data.lat), lng: parseFloat(data.lng) };
    lastKnownPosition = pos; 
    
    if(!currentMarker) {
        currentMarker = new google.maps.Marker({
            position: pos, map: map, title: realName,
            // 红色标点代表当前车的位置或路线终点
            label: { text: "终", color: "white", fontSize: "12px", fontWeight: "bold" },
            icon: { 
                path: google.maps.SymbolPath.CIRCLE, 
                scale: 12, 
                fillColor: "#ef4444", 
                fillOpacity: 1, 
                strokeWeight: 2, 
                strokeColor: "white" 
            },
            zIndex: 200 // 保持最上层
        });
    } else {
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
    updateStatusCard(data);
}

window.focusOnDriver = function() {
    if (lastKnownPosition && lastKnownPosition.lat && map) { 
        map.panTo(lastKnownPosition); 
        map.setZoom(17); 
    }
}