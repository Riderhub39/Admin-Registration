// live-tracking-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, onSnapshot, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// 🟢 导入通用 UI 提示和加载函数
import { showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ⚠️ Store Location 默认配置 (如需动态可改为从 Firestore 读取)
const STORE_LOCATION = { lat: 4.5975, lng: 101.0901 }; 
const STORE_RADIUS_METERS = 500; 

let map, currentMarker, storeCircle;
let directionsService, directionsRenderer; 

let activeStaffMap = {}; 
let usersMap = {}; 

let lastKnownPosition = null;
let unsubscribeLastLoc = null;

// 初始化地图（该函数在 Google Maps API 加载后会被调用）
window.initMap = function() {
    console.log("Google Maps API loaded.");
};

export async function initLiveTrackingApp() {
    document.getElementById('loadingText').innerText = "Initializing Map...";
    await fetchUsers(); 
    
    if(typeof google === 'undefined' || !google.maps) {
        hideLoading();
        showStatusAlert('statusMessage', 'Google Maps failed to load. Please check your internet connection.', false);
        return;
    }

    // 初始化 Google Map
    map = new google.maps.Map(document.getElementById("map"), {
        center: STORE_LOCATION,
        zoom: 12,
        disableDefaultUI: false,
        zoomControl: true,
    });

    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
        map: map,
        suppressMarkers: true,
        preserveViewport: true,
        polylineOptions: {
            strokeColor: "#2563eb",
            strokeOpacity: 0.8,
            strokeWeight: 6
        }
    });

    storeCircle = new google.maps.Circle({
        strokeColor: "#F59E0B", strokeOpacity: 0.8, strokeWeight: 2,
        fillColor: "#F59E0B", fillOpacity: 0.1,
        map: map,
        center: STORE_LOCATION,
        radius: STORE_RADIUS_METERS,
    });

    const datePicker = document.getElementById('datePicker');
    const now = new Date();
    const localDateString = now.toLocaleDateString('en-CA'); 
    datePicker.value = localDateString;
    
    // 首次加载列表
    loadDriverListForSelectedDate();

    // 绑定日期切换事件
    datePicker.addEventListener('change', () => {
        loadDriverListForSelectedDate();
        
        // 清空当前视图
        if(currentMarker) currentMarker.setMap(null);
        if(directionsRenderer) directionsRenderer.setDirections({routes: []});
        document.getElementById('statusOverlay').classList.add('d-none');
        window.selectedUid = null;
    });

    // 绑定搜索事件
    document.getElementById('searchInput').addEventListener('keyup', (e) => {
        const term = e.target.value.toLowerCase();
        document.querySelectorAll('.user-item').forEach(item => {
            item.style.display = item.getAttribute('data-name').toLowerCase().includes(term) ? 'block' : 'none';
        });
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
    
    hideLoading();
    document.getElementById('mainContainer').classList.remove('d-none');
}

async function fetchUsers() {
    try {
        const snap = await getDocs(collection(db, "users"));
        snap.forEach(doc => {
            const d = doc.data();
            const key = d.authUid || doc.id;
            const name = d.personal?.name || d.name || "Unknown Staff";
            usersMap[key] = name;
        });
    } catch (e) { 
        console.error(e); 
    }
}

// 🟢 根据所选日期加载侧边栏列表
async function loadDriverListForSelectedDate() {
    if(unsubscribeLastLoc) {
        unsubscribeLastLoc();
        unsubscribeLastLoc = null;
    }

    const dateStr = document.getElementById('datePicker').value;
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA');
    const listDiv = document.getElementById('driverList');
    
    listDiv.innerHTML = '<div class="text-center text-muted small py-4">Loading...</div>';

    if (dateStr === todayStr) {
        // 如果选的是今天：使用实时监听
        unsubscribeLastLoc = onSnapshot(collection(db, "user_last_locations"), (snapshot) => {
            let html = '';
            let hasData = false;

            snapshot.forEach(doc => {
                const data = doc.data();
                if(!data.timestamp) return;

                const lastUpdate = data.timestamp.toDate();
                const logDateStr = lastUpdate.toLocaleDateString('en-CA');

                // 关键过滤：只显示今天有位置更新的员工
                if (logDateStr !== todayStr) return;

                hasData = true;
                const uid = doc.id;
                const realName = usersMap[uid] || "Staff";
                activeStaffMap[uid] = data;

                if (window.selectedUid === uid) {
                    lastKnownPosition = { lat: parseFloat(data.lat), lng: parseFloat(data.lng) };
                }

                const isOnline = (now - lastUpdate) < 1000 * 60 * 15; 
                const statusBadge = isOnline 
                    ? '<div class="d-flex align-items-center gap-1"><span class="status-dot dot-online"></span> <small class="text-success" style="font-size:10px">Active</small></div>'
                    : '<span class="badge bg-secondary bg-opacity-10 text-secondary border" style="font-size:10px">Offline</span>';

                html += buildUserListItem(uid, realName, lastUpdate.toLocaleTimeString(), statusBadge);
            });

            listDiv.innerHTML = hasData ? html : '<div class="text-center text-muted small py-4">No active drivers today.</div>';
            if (typeof lucide !== 'undefined') lucide.createIcons();
        });

    } else {
        // 如果选的是历史日期：单次查询
        try {
            const logsSnap = await getDocs(query(
                collection(db, "tracking_logs"), 
                where("date", "==", dateStr)
            ));

            // 提取当天产生过轨迹的唯一用户 ID
            const usersOnThatDay = new Set();
            logsSnap.forEach(d => {
                usersOnThatDay.add(d.data().uid);
            });

            if (usersOnThatDay.size === 0) {
                listDiv.innerHTML = '<div class="text-center text-muted small py-4">No tracking records for this date.</div>';
                return;
            }

            let html = '';
            usersOnThatDay.forEach(uid => {
                const realName = usersMap[uid] || "Staff";
                const statusBadge = '<span class="badge bg-light text-secondary border" style="font-size:10px">History</span>';
                html += buildUserListItem(uid, realName, "Archived Data", statusBadge);
            });

            listDiv.innerHTML = html;
            if (typeof lucide !== 'undefined') lucide.createIcons();

        } catch(e) {
            console.error("Error loading history list:", e);
            listDiv.innerHTML = '<div class="text-center text-danger small py-4">Error loading data.</div>';
        }
    }
}

function buildUserListItem(uid, realName, timeText, statusBadge) {
    return `
        <div class="user-item p-3" id="user-${uid}" data-name="${realName}" onclick="window.viewStaffRoute('${uid}', '${realName}')">
            <div class="d-flex align-items-center gap-3">
                <div class="avatar-placeholder bg-primary bg-opacity-10 text-primary small">${realName.substring(0, 2).toUpperCase()}</div>
                <div class="flex-grow-1 overflow-hidden">
                    <div class="fw-bold text-dark text-truncate">${realName}</div>
                    <div class="small text-muted"><i data-lucide="clock" class="size-3"></i> ${timeText}</div>
                </div>
                ${statusBadge}
            </div>
        </div>`;
}

// 暴露到 window
window.viewStaffRoute = async function(uid, realName) {
    window.selectedUid = uid;
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`user-${uid}`)?.classList.add('active');
    document.getElementById('statusOverlay').classList.remove('d-none');
    document.getElementById('overlayName').innerText = realName;

    if(currentMarker) currentMarker.setMap(null);
    if(directionsRenderer) directionsRenderer.setDirections({routes: []});
    lastKnownPosition = null; 

    const dateStr = document.getElementById('datePicker').value;

    const q = query(
        collection(db, "tracking_logs"), 
        where("uid", "==", uid),
        where("date", "==", dateStr),
        orderBy("timestamp", "asc")
    );

    try {
        const logsSnap = await getDocs(q);
        const logs = [];
        logsSnap.forEach(d => logs.push(d.data()));
        
        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA');

        if (logs.length > 0) {
            drawRoute(logs, realName); 
        } else {
            if (dateStr === todayStr && activeStaffMap[uid]) {
                const lastPos = activeStaffMap[uid];
                const lastUpdateDate = lastPos.timestamp ? lastPos.timestamp.toDate().toLocaleDateString('en-CA') : '';
                if (lastUpdateDate === todayStr) {
                     updateCarMarker(lastPos, realName);
                } else {
                    showNoRecordState();
                }
            } else {
                showNoRecordState();
            }
        }

        setTimeout(() => { if(lastKnownPosition) window.focusOnDriver(); }, 600);

    } catch (e) {
        console.error("Error fetching logs:", e);
    }
};

function showNoRecordState() {
    document.getElementById('overlaySpeed').innerText = "0";
    document.getElementById('overlayTime').innerText = "No Tracking Data";
    document.getElementById('overlayStatusTag').innerText = "No Record";
    document.getElementById('overlayStatusTag').className = "badge bg-secondary";
    if(currentMarker) currentMarker.setMap(null);
    if(directionsRenderer) directionsRenderer.setDirections({routes: []});
    lastKnownPosition = null;
}

function drawRoute(logs, realName) {
    if(currentMarker) currentMarker.setMap(null);
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
        updateCarMarker(logs[logs.length - 1], realName);
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
        intermediatePoints.forEach(pt => {
            waypoints.push({ location: pt.location, stopover: false });
        });
    }

    directionsService.route({
        origin: origin,
        destination: destination,
        waypoints: waypoints,
        travelMode: google.maps.TravelMode.DRIVING,
    }, (response, status) => {
        if (status === "OK") {
            directionsRenderer.setDirections(response);
            updateStatusCard(logs[logs.length - 1]);
            updateCarMarker(logs[logs.length - 1], realName);
        } else {
            console.error("Directions request failed due to " + status);
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

function updateCarMarker(lastLog, realName) {
    const pos = { 
        lat: parseFloat(lastLog.lat), 
        lng: parseFloat(lastLog.lng) 
    };
    lastKnownPosition = pos; 
    
    if(currentMarker) currentMarker.setMap(null);

    currentMarker = new google.maps.Marker({
        position: pos, 
        map: map, 
        title: realName,
        icon: { 
            path: google.maps.SymbolPath.CIRCLE, 
            scale: 7, 
            fillColor: "#2563eb", 
            fillOpacity: 1, 
            strokeWeight: 2, 
            strokeColor: "white" 
        }
    });
    
    map.panTo(pos);
    map.setZoom(16);

    document.getElementById('overlaySpeed').innerText = (lastLog.speed * 3.6).toFixed(1);
    document.getElementById('overlayTime').innerText = lastLog.timestamp ? lastLog.timestamp.toDate().toLocaleTimeString() : '-';
}

window.focusOnDriver = function() {
    if (lastKnownPosition && lastKnownPosition.lat && map) { 
        map.setCenter(lastKnownPosition); 
        map.setZoom(17); 
    }
}