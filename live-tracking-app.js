// live-tracking-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
// 🟢 引入 RTDB
import { getDatabase, ref, onValue, off } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";
import { showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const rtdb = getDatabase(app); 
const auth = getAuth(app);

const STORE_LOCATION = { lat: 4.5975, lng: 101.0901 }; 
const STORE_RADIUS_METERS = 500; 

let map, currentMarker, storeCircle;
let directionsService, directionsRenderer; 

let activeStaffMap = {}; 
let usersMap = {}; 

let lastKnownPosition = null;
let activeRTDBListener = null;

// ==========================================
// 1. Google Maps 动态加载机制 (防止 initMap 报错)
// ==========================================
export async function initLiveTrackingApp() {
    showLoading();
    document.getElementById('loadingText').innerText = "Initializing Tracking...";
    
    await fetchUsers(); 

    // 如果 HTML 中还没挂载 initMap，就在这里接管
    if (!window.initMap) {
        window.initMap = function() {
            setupMapAndUI();
        };
    } else {
        // 如果 API 已经加载完了
        if (typeof google !== 'undefined' && google.maps) {
            setupMapAndUI();
        } else {
            // 重写占位的 initMap
            window.initMap = function() {
                setupMapAndUI();
            };
        }
    }
}

function setupMapAndUI() {
    if(typeof google === 'undefined' || !google.maps) {
        hideLoading();
        showStatusAlert('statusMessage', 'Google Maps failed to load. Please check your key.', false);
        return;
    }

    map = new google.maps.Map(document.getElementById("map"), {
        center: STORE_LOCATION,
        zoom: 12,
        disableDefaultUI: false,
        zoomControl: true,
        styles: [ { "featureType": "poi", "stylers": [{ "visibility": "off" }] } ]
    });

    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
        map: map,
        suppressMarkers: true,
        preserveViewport: true,
        polylineOptions: { strokeColor: "#2563eb", strokeOpacity: 0.8, strokeWeight: 6 }
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
    if(activeRTDBListener) { off(activeRTDBListener); activeRTDBListener = null; }
    if(currentMarker) currentMarker.setMap(null);
    if(directionsRenderer) directionsRenderer.setDirections({routes: []});
    document.getElementById('statusOverlay').classList.add('d-none');
    window.selectedUid = null;
    lastKnownPosition = null;
}

// ==========================================
// 2. 数据获取
// ==========================================
async function fetchUsers() {
    try {
        const snap = await getDocs(collection(db, "users"));
        snap.forEach(doc => {
            const d = doc.data();
            usersMap[d.authUid || doc.id] = d.personal?.name || d.name || "Unknown Staff";
        });
    } catch (e) { console.error(e); }
}

async function loadDriverListForSelectedDate() {
    if(activeRTDBListener) { off(activeRTDBListener); activeRTDBListener = null; }

    const dateStr = document.getElementById('datePicker').value;
    const todayStr = new Date().toLocaleDateString('en-CA');
    const listDiv = document.getElementById('driverList');
    listDiv.innerHTML = '<div class="text-center text-muted small py-4">Syncing...</div>';

    if (dateStr === todayStr) {
        // 🟢 今天：监听 RTDB
        const liveRef = ref(rtdb, 'live_locations');
        activeRTDBListener = onValue(liveRef, (snapshot) => {
            const data = snapshot.val();
            if (!data) {
                listDiv.innerHTML = '<div class="text-center text-muted small py-4">No active drivers today.</div>';
                return;
            }

            let html = '';
            Object.entries(data).forEach(([uid, val]) => {
                const realName = usersMap[uid] || "Staff";
                const lastUpdate = new Date(val.lastUpdate);
                
                // 15分钟内算在线
                const isOnline = (new Date() - lastUpdate) < 1000 * 60 * 15; 
                const statusBadge = isOnline 
                    ? '<div class="d-flex align-items-center gap-1"><span class="status-dot dot-online"></span> <small class="text-success" style="font-size:10px">Active</small></div>'
                    : '<span class="badge bg-secondary bg-opacity-10 text-secondary border" style="font-size:10px">Offline</span>';

                html += buildUserListItem(uid, realName, lastUpdate.toLocaleTimeString(), statusBadge);
            });
            listDiv.innerHTML = html;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        });
    } else {
        // 🟢 历史：解析 tracking_batches 
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
                html += buildUserListItem(uid, usersMap[uid] || "Staff", "Archived Data", '<span class="badge bg-light text-secondary border" style="font-size:10px">History</span>');
            });
            listDiv.innerHTML = html;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        } catch(e) {
            listDiv.innerHTML = '<div class="text-center text-danger small py-4">Error loading data.</div>';
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
        // 🟢 RTDB 实时跟随模式
        const singleRef = ref(rtdb, `live_locations/${uid}`);
        onValue(singleRef, (snapshot) => {
            const val = snapshot.val();
            if (val && window.selectedUid === uid) {
                updateCarMarker(val, realName);
            }
        });
    }

    // 🟢 加载历史轨迹批次 (tracking_batches)
    try {
        const snap = await getDocs(query(collection(db, "tracking_batches"), where("uid", "==", uid), where("date", "==", dateStr)));
        
        let allPoints = [];
        const batches = snap.docs.map(d => d.data());
        // 按照上传时间排序，确保路线是顺的
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

function drawRoute(logs, realName) {
    if(directionsRenderer) directionsRenderer.setDirections({routes: []});
    
    const filteredLogs = [];
    let lastAddedLatLng = null;

    logs.forEach((log, index) => {
        const latLng = new google.maps.LatLng(log.lat, log.lng);
        let shouldAdd = false;

        if (index === 0 || index === logs.length - 1) {
            shouldAdd = true;
        } else {
            const distFromLast = google.maps.geometry.spherical.computeDistanceBetween(lastAddedLatLng, latLng);
            if (distFromLast > 200) { 
                shouldAdd = true;
            }
        }

        if (shouldAdd) {
            filteredLogs.push({ location: latLng }); 
            lastAddedLatLng = latLng;
        }
    });

    if (filteredLogs.length < 2) {
        return; 
    }

    const maxWaypoints = 23;
    const waypoints = [];
    const origin = filteredLogs[0].location;
    const destination = filteredLogs[filteredLogs.length - 1].location;
    const intermediatePoints = filteredLogs.slice(1, filteredLogs.length - 1);

    if (intermediatePoints.length > maxWaypoints) {
        const step = Math.ceil(intermediatePoints.length / maxWaypoints);
        for (let i = 0; i < intermediatePoints.length; i += step) {
            waypoints.push({ location: intermediatePoints[i].location, stopover: false });
        }
    } else {
        intermediatePoints.forEach(pt => waypoints.push({ location: pt.location, stopover: false }));
    }

    directionsService.route({
        origin: origin,
        destination: destination,
        waypoints: waypoints,
        travelMode: google.maps.TravelMode.DRIVING,
    }, (response, status) => {
        if (status === "OK") {
            directionsRenderer.setDirections(response);
            
            // 历史模式下，如果当天没有 RTDB 实时更新，则用最后一个批次点的信息
            const isToday = document.getElementById('datePicker').value === new Date().toLocaleDateString('en-CA');
            if(!isToday) {
               updateCarMarker({
                   lat: logs[logs.length-1].lat, 
                   lng: logs[logs.length-1].lng,
                   lastUpdate: logs[logs.length-1].timestamp,
                   speed: 0
               }, realName);
               updateStatusCard(logs[logs.length - 1]);
            }
        }
    });
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
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#2563eb", fillOpacity: 1, strokeWeight: 2, strokeColor: "white" }
        });
    } else {
        currentMarker.setPosition(pos);
    }
    
    document.getElementById('overlaySpeed').innerText = ((data.speed || 0) * 3.6).toFixed(1);
    
    if (data.lastUpdate) {
        // 如果是 RTDB 的毫秒级时间戳或者是 Batch 的 ISO 字符串
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