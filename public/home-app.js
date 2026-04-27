// home-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, onSnapshot, addDoc, serverTimestamp, doc, getDoc, setDoc, updateDoc, deleteDoc, orderBy, limit, startAfter, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
// 🚀 RTDB functions for Live Tracking Stats
import { getDatabase, ref as rtdbRef, onValue } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

import { firebaseConfig } from "./firebase-config.js";

// 🟢 Import utils public methods
import { normalizeDate, logAdminAction, showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app); 
const rtdb = getDatabase(app); 

let attChartInstance = null;
let announceModal, officeModal, driverModal, auditModal, photoModal;
let lastLogDoc = null;
const PAGE_SIZE = 20;

let globalStaffMap = {}; 

export async function initHomeApp(userData) {
    if (typeof bootstrap !== 'undefined') {
        announceModal = new bootstrap.Modal(document.getElementById('announceModal'));
        officeModal = new bootstrap.Modal(document.getElementById('officeSettingsModal'));
        driverModal = new bootstrap.Modal(document.getElementById('driverSetupModal'));
        photoModal = new bootstrap.Modal(document.getElementById('photoModal'));

        if (userData.role === 'manager') {
            document.getElementById('managerAuditAction').classList.remove('d-none');
            document.getElementById('managerOfficeAction').classList.remove('d-none');
            auditModal = new bootstrap.Modal(document.getElementById('auditModal'));
            preloadStaffMap();
        }
    }

    initDashboard(); 
    
    hideLoading(); 
    document.getElementById('mainContainer').classList.remove('d-none');
    lucide.createIcons();
}

async function preloadStaffMap() {
    try {
        const snap = await getDocs(collection(db, "users"));
        snap.forEach(doc => {
            const data = doc.data();
            globalStaffMap[doc.id] = data.personal?.name || data.name || doc.id;
            if (data.authUid) {
                globalStaffMap[data.authUid] = data.personal?.name || data.name || data.authUid;
            }
        });
    } catch (e) {
        console.error("Failed to preload staff map", e);
    }
}

// --- 🟢 Audit Log Logic ---

window.openAuditModal = () => {
    if (auditModal) auditModal.show();
    window.resetAuditLogs();
};

window.resetAuditLogs = () => {
    document.getElementById('auditFilterDate').value = "";
    document.getElementById('auditFilterEmail').value = "";
    lastLogDoc = null;
    window.loadAuditLogs(false);
};

window.applyAuditFilters = () => {
    lastLogDoc = null;
    window.loadAuditLogs(false);
};

window.loadAuditLogs = async (isNextPage = false) => {
    const container = document.getElementById('auditLogList');
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    const fDate = document.getElementById('auditFilterDate').value;
    const fEmail = document.getElementById('auditFilterEmail').value.trim();

    if (!isNextPage) container.innerHTML = '<tr><td colspan="5" class="text-center py-5"><div class="spinner-border spinner-border-sm text-primary"></div></td></tr>';

    let constraints = [orderBy("timestamp", "desc"), limit(PAGE_SIZE)];
    if (fDate) {
        const start = new Date(fDate); start.setHours(0,0,0,0);
        const end = new Date(fDate); end.setHours(23,59,59,999);
        constraints.push(where("timestamp", ">=", Timestamp.fromDate(start)), where("timestamp", "<=", Timestamp.fromDate(end)));
    }
    if (fEmail) constraints.push(where("operatorEmail", "==", fEmail));
    if (isNextPage && lastLogDoc) constraints.push(startAfter(lastLogDoc));

    try {
        const snap = await getDocs(query(collection(db, "audit_logs"), ...constraints));
        if (!isNextPage) container.innerHTML = "";
        if (snap.empty && !isNextPage) {
            container.innerHTML = '<tr><td colspan="5" class="text-center py-5">No logs match criteria.</td></tr>';
            loadMoreBtn.classList.add('d-none');
            return;
        }
        snap.forEach(d => {
            const log = d.data();
            const time = log.timestamp ? new Date(log.timestamp.seconds * 1000).toLocaleString('en-GB') : 'Just now';
            
            let targetDisplay = log.targetUid || '-';
            if (targetDisplay === "GLOBAL" || targetDisplay === "MULTIPLE") {
            } else if (globalStaffMap[targetDisplay]) {
                targetDisplay = `👤 ${globalStaffMap[targetDisplay]}`;
            } else if (log.action.includes("ANNOUNCEMENT")) {
                if (log.details?.new?.title) targetDisplay = `📢 ${log.details.new.title}`;
                else if (log.details?.old?.title) targetDisplay = `📢 ${log.details.old.title}`;
                else targetDisplay = "📢 Announcement";
            } else if (log.action.includes("LEAVE") || log.action.includes("CORRECTION") || log.action.includes("PAYSLIP")) {
                if (log.details?.old?.empName) targetDisplay = `👤 ${log.details.old.empName}`;
                else if (log.details?.old?.name) targetDisplay = `👤 ${log.details.old.name}`;
            }

            const tr = document.createElement('tr');
            tr.className = "log-item";
            tr.innerHTML = `
                <td class="ps-4 small text-muted text-mono">${time}</td>
                <td><div class="fw-bold small text-dark">${log.operatorEmail}</div></td>
                <td><span class="badge bg-primary bg-opacity-10 text-primary border">${log.action.replace(/_/g, ' ')}</span></td>
                <td class="small fw-bold text-secondary" style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${targetDisplay}">${targetDisplay}</td>
                <td class="text-end pe-4"><button class="btn btn-xs btn-outline-dark" onclick="window.inspectLog('${d.id}')">Inspect</button></td>`;
            container.appendChild(tr);
        });
        lastLogDoc = snap.docs[snap.docs.length - 1];
        loadMoreBtn.classList.toggle('d-none', snap.docs.length < PAGE_SIZE);
        lucide.createIcons();
    } catch (e) { container.innerHTML = `<tr><td colspan="5" class="text-center text-danger small">${e.message}</td></tr>`; }
};

function formatFirestoreData(obj) {
    if (obj === null || obj === undefined) return "None / Removed";
    if (typeof obj !== 'object') return obj;

    if (obj.seconds !== undefined && obj.nanoseconds !== undefined) {
        const date = new Date(obj.seconds * 1000);
        return date.toLocaleString('en-GB', { 
            day: '2-digit', month: 'short', year: 'numeric', 
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true 
        });
    }

    if (obj.latitude !== undefined && obj.longitude !== undefined) {
        return `📍 Lat: ${obj.latitude.toFixed(4)}, Lng: ${obj.longitude.toFixed(4)}`;
    }

    const formatted = Array.isArray(obj) ? [] : {};
    for (const [key, value] of Object.entries(obj)) {
        formatted[key] = formatFirestoreData(value);
    }
    return formatted;
}

let inspectModalInstance;
window.inspectLog = async (id) => {
    if (!inspectModalInstance) {
        inspectModalInstance = new bootstrap.Modal(document.getElementById('inspectModal'));
    }
    
    try {
        const snap = await getDoc(doc(db, "audit_logs", id));
        if (!snap.exists()) { 
            showStatusAlert('statusMessage', 'Log not found.', false); 
            return; 
        }
        
        const details = snap.data().details;
        if (!details) { 
            showStatusAlert('statusMessage', 'No details available for this log.', false); 
            return; 
        }

        const oldContainer = document.getElementById('inspectOldDataContainer');
        const newContainer = document.getElementById('inspectNewDataContainer');
        const oldBox = document.getElementById('inspectOldData');
        const newBox = document.getElementById('inspectNewData');

        const formattedOld = details.old ? formatFirestoreData(details.old) : null;
        const formattedNew = details.new ? formatFirestoreData(details.new) : null;

        if (formattedOld && Object.keys(formattedOld).length > 0) {
            oldBox.innerText = JSON.stringify(formattedOld, null, 2);
            oldContainer.classList.remove('d-none');
        } else {
            oldContainer.classList.add('d-none');
        }

        if (formattedNew && Object.keys(formattedNew).length > 0) {
            newBox.innerText = JSON.stringify(formattedNew, null, 2);
            newContainer.classList.remove('d-none');
        } else {
            newContainer.classList.add('d-none');
        }

        inspectModalInstance.show();
    } catch (e) {
        console.error("Error loading log details:", e);
        showStatusAlert('statusMessage', 'Error loading details.', false);
    }
};

// --- Attendance Stats Logic ---

async function loadAttendanceStats() {
    const todayStr = normalizeDate(`${new Date().getFullYear()}-${new Date().getMonth() + 1}-${new Date().getDate()}`);
    try {
        const [usersSnap, attSnap, schedSnap, leaveSnap, holSnap] = await Promise.all([
            getDocs(query(collection(db, "users"))),
            getDocs(query(collection(db, "attendance"), where("date", "==", todayStr))),
            getDocs(query(collection(db, "schedules"), where("date", "==", todayStr))),
            getDocs(query(collection(db, "leaves"), where("status", "==", "Approved"), where("endDate", ">=", todayStr))),
            getDoc(doc(db, "settings", "holidays"))
        ]);

        const holidaysMap = {};
        if (holSnap.exists() && holSnap.data().holiday_list) {
            holSnap.data().holiday_list.forEach(h => { holidaysMap[h.date] = true; });
        }

        const staffDocIds = new Set();
        const authUidToDocId = {}; 
        const docIdToAuthMap = {}; // 🟢 FIX: Added missing variable declaration

        usersSnap.forEach(doc => {
            const data = doc.data();
            if (data.status !== 'disabled') {
                staffDocIds.add(doc.id);
                if (data.authUid) {
                    authUidToDocId[data.authUid] = doc.id;
                    docIdToAuthMap[doc.id] = data.authUid; // 🟢 FIX: Populate the map
                }
            }
        });

        const attendanceMap = {}; 
        attSnap.forEach(doc => {
            const d = doc.data();
            if (d.verificationStatus !== 'Rejected') {
                let docId = authUidToDocId[d.uid] || (staffDocIds.has(d.uid) ? d.uid : null);
                if (docId) {
                    if (!attendanceMap[docId]) attendanceMap[docId] = [];
                    attendanceMap[docId].push(d);
                }
            }
        });

        const scheduleMap = {}; 
        schedSnap.forEach(doc => {
            const d = doc.data();
            if (d.start && staffDocIds.has(d.userId)) {
                const st = d.start.toDate();
                if (!scheduleMap[d.userId] || st < scheduleMap[d.userId]) scheduleMap[d.userId] = st;
            }
        });

        const leaveMap = {};
        leaveSnap.forEach(doc => {
            const data = doc.data();
            if (!data.startDate || !data.endDate) return; // 🟢 FIX: Prevent crash if dates are missing
            
            const eUid = data.authUid || docIdToAuthMap[data.uid] || data.uid;
            
            const [sY, sM, sD] = data.startDate.split('-');
            const [eY, eM, eD] = data.endDate.split('-');
            let curr = new Date(sY, sM - 1, sD);
            const endD = new Date(eY, eM - 1, eD);
            
            while(curr <= endD) {
                const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
                if(dStr === todayStr) {
                    let docId = authUidToDocId[eUid] || (staffDocIds.has(eUid) ? eUid : null);
                    if (docId) leaveMap[docId] = data; 
                }
                curr.setDate(curr.getDate() + 1);
            }
        });

        let present = 0, late = 0, absent = 0;
        let expectedCount = 0;

        staffDocIds.forEach(docId => {
            const records = attendanceMap[docId] || [];
            const schedStart = scheduleMap[docId];
            
            let leaveObj = leaveMap[docId];
            let leaveType = leaveObj ? leaveObj.type : null;
            let duration = leaveObj?.duration || 'Full Day';
            const isPH = holidaysMap[todayStr] && (!!schedStart || !!leaveType);

            if (schedStart) {
                if (!isPH && !(leaveType && duration === 'Full Day')) {
                    expectedCount++;
                }
            }

            if (records.length > 0) {
                present++;
                const clockIn = records.filter(r => r.session === 'Clock In').sort((a,b) => (a.timestamp?.seconds||0)-(b.timestamp?.seconds||0))[0];
                
                if (clockIn && schedStart) {
                    const time = clockIn.manualIn ? new Date(`${todayStr}T${clockIn.manualIn}:00`) : clockIn.timestamp.toDate();
                    const lateThreshold = new Date(schedStart.getTime() + 60000); 
                    
                    if (time >= lateThreshold) {
                        late++;
                    }
                }
            } else if (schedStart) {
                if (!isPH && !leaveType) {
                    absent++; 
                } else if (leaveType && duration !== 'Full Day') {
                    absent++; 
                }
            }
        });

        document.getElementById('countPresent').innerText = Math.max(0, present - late);
        document.getElementById('countLate').innerText = late;
        document.getElementById('countAbsent').innerText = absent;
        
        const total = Math.max(expectedCount, present);
        document.getElementById('attPercent').innerText = total ? Math.round((present / total) * 100) + '%' : '0%';
        
        updateChart(present, absent, late);
    } catch (e) { 
        console.error("Dashboard Load Error:", e); // Print the actual error logic to your console to prevent silent failures in the future
    }
}

function updateChart(present, absent, late) {
    const ctx = document.getElementById('attChart').getContext('2d');
    if (attChartInstance) attChartInstance.destroy();
    attChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['On Time', 'Late', 'Absent'],
            datasets: [{ data: [Math.max(0, present - late), late, absent], backgroundColor: ['#22c55e', '#f59e0b', '#ef4444'], borderWidth: 0, cutout: '75%' }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });
}

window.goToAttendance = (filter) => window.location.href = `attendance.html?filter=${filter}`;

// 🚀 RTDB function for Live Tracking Stats
function loadTrackingStats() {
    const todayStr = new Date().toLocaleDateString('en-CA');
    const liveRef = rtdbRef(rtdb, 'live_locations');
    
    onValue(liveRef, (snapshot) => {
        let onlineCount = 0;
        let offlineCount = 0;
        const data = snapshot.val();
        
        if (data) {
            Object.values(data).forEach(val => {
                if (!val.lastUpdate) return;
                
                const lastUpdateDate = new Date(val.lastUpdate);
                const updateDateStr = lastUpdateDate.toLocaleDateString('en-CA');
                
                // Only count drivers who have logged a location TODAY
                if (updateDateStr === todayStr) {
                    const isOnline = val.isTracking !== false && (new Date() - lastUpdateDate) < 1000 * 60 * 15; 
                    if (isOnline) {
                        onlineCount++;
                    } else {
                        offlineCount++;
                    }
                }
            });
        }
        
        document.getElementById('trackOnline').innerText = onlineCount;
        document.getElementById('trackOffline').innerText = offlineCount;
    });
}

function loadAllTasks() {
    onSnapshot(query(collection(db, "leaves"), where("status", "==", "Pending")), s => {
        const count = s.size;
        const badge = document.getElementById('badge-leave');
        badge.innerText = count;
        badge.style.display = count > 0 ? 'inline-block' : 'none'; 
    });
    onSnapshot(query(collection(db, "attendance_corrections"), where("status", "==", "Pending")), s => {
        const count = s.size;
        const badge = document.getElementById('badge-att');
        badge.innerText = count;
        badge.style.display = count > 0 ? 'inline-block' : 'none';
    });
    onSnapshot(query(collection(db, "edit_requests"), where("status", "==", "Pending")), s => {
        const count = s.size;
        const badge = document.getElementById('badge-edit');
        badge.innerText = count;
        badge.style.display = count > 0 ? 'inline-block' : 'none';
    });
}

// --- 🟢 Office Settings ---
let currentWifiList = [];
window.openOfficeSettingsModal = async () => {
    officeModal.show();
    const docSnap = await getDoc(doc(db, "settings", "office_location"));
    if (docSnap.exists()) {
        const data = docSnap.data();
        document.getElementById('officeLat').value = data.latitude || '';
        document.getElementById('officeLng').value = data.longitude || '';
        document.getElementById('officeRadius').value = data.radius || 500;
        currentWifiList = data.allowedWifis || [];
        window.renderWifiList();
    }
};

window.renderWifiList = () => {
    const list = document.getElementById('wifiListContainer');
    list.innerHTML = currentWifiList.map((wifi, i) => `
        <div class="wifi-item">
            <div><b>${wifi.ssid}</b><br><small class="text-muted">${wifi.bssid || 'Any'}</small></div>
            <button class="btn btn-sm text-danger" onclick="window.removeWifi(${i})"><i data-lucide="trash-2" class="size-4"></i></button>
        </div>`).join('');
    lucide.createIcons();
};

window.addWifiToList = () => {
    const ssid = document.getElementById('newWifiSSID').value.trim();
    const bssid = document.getElementById('newWifiBSSID').value.trim();
    if (!ssid) return;
    currentWifiList.push({ ssid, bssid });
    window.renderWifiList();
    document.getElementById('newWifiSSID').value = '';
    document.getElementById('newWifiBSSID').value = '';
};

window.removeWifi = (i) => { currentWifiList.splice(i, 1); window.renderWifiList(); };

window.saveOfficeSettings = async () => {
    showLoading(); 
    try {
        const newData = { 
            latitude: parseFloat(document.getElementById('officeLat').value), 
            longitude: parseFloat(document.getElementById('officeLng').value), 
            radius: parseFloat(document.getElementById('officeRadius').value), 
            allowedWifis: currentWifiList, updatedAt: serverTimestamp() 
        };
        const oldSnap = await getDoc(doc(db, "settings", "office_location"));
        
        await setDoc(doc(db, "settings", "office_location"), newData, { merge: true });
        await logAdminAction(db, auth.currentUser, "UPDATE_OFFICE_SETTINGS", "GLOBAL", oldSnap.data() || {}, newData);
        
        officeModal.hide();
        hideLoading(); 
        showStatusAlert('statusMessage', 'Office settings saved.', true);
    } catch (e) {
        hideLoading(); 
        showStatusAlert('statusMessage', 'Error saving settings.', false); 
    }
};

// --- 🟢 Announcements ---
window.openAnnouncementModal = () => { window.resetAnnounceForm(); announceModal.show(); window.loadAnnouncements(); };
let announceUnsubscribe = null;

export function setupAnnounceFileListener() {
    const fileInput = document.getElementById('announceFile');
    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            const clearBtn = document.getElementById('clearFileBtn');
            if (e.target.files.length > 0) {
                clearBtn.classList.remove('d-none');
            } else {
                clearBtn.classList.add('d-none');
            }
        });
    }
}

window.clearAnnounceFile = () => {
    document.getElementById('announceFile').value = '';
    document.getElementById('clearFileBtn').classList.add('d-none');
}

window.loadAnnouncements = () => {
    if (announceUnsubscribe) return;
    announceUnsubscribe = onSnapshot(query(collection(db, "announcements"), orderBy("createdAt", "desc")), snap => {
        document.getElementById('announceCount').innerText = snap.size;
        document.getElementById('announceList').innerHTML = snap.docs.map(doc => {
            const d = doc.data();
            
            let attachmentHtml = '';
            if (d.attachmentUrl) {
                attachmentHtml = `<div class="mt-2"><button class="btn btn-sm btn-light border text-primary" onclick="window.viewPhoto('${d.attachmentUrl}')"><i data-lucide="paperclip" class="size-3 me-1"></i>View Attachment</button></div>`;
            }

            let titleHtml = d.title ? `<div class="fw-bold text-dark mb-1">${d.title}</div>` : '';

            return `
            <div class="card mb-2 p-3 border-0 shadow-sm">
                ${titleHtml}
                <div class="small mb-1 text-secondary">${d.message}</div>
                ${attachmentHtml}
                <div class="text-end mt-2 pt-2 border-top">
                    <small class="text-muted float-start">${d.createdAt ? new Date(d.createdAt.seconds * 1000).toLocaleDateString() : 'Just now'}</small>
                    <button class="btn btn-xs text-danger" onclick="window.deleteAnnouncement('${doc.id}')">Delete</button>
                </div>
            </div>`;
        }).join('');
        lucide.createIcons();
    });
};

window.submitAnnouncement = async () => {
    const title = document.getElementById('announceTitle').value.trim();
    const text = document.getElementById('announceText').value.trim();
    const fileInput = document.getElementById('announceFile');
    const btn = document.getElementById('postBtn');

    if (!title) { showStatusAlert('statusMessage', "Please enter a title.", false); return; }
    if (!text) { showStatusAlert('statusMessage', "Please enter a message.", false); return; }
    
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Posting...`;

    try {
        let attachmentUrl = null;

        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            const storageReference = storageRef(storage, `announcements/${Date.now()}_${file.name}`);
            await uploadBytes(storageReference, file);
            attachmentUrl = await getDownloadURL(storageReference);
        }

        const payload = { 
            title: title,
            message: text, 
            createdAt: serverTimestamp(), 
            author: auth.currentUser.email 
        };

        if (attachmentUrl) {
            payload.attachmentUrl = attachmentUrl;
        }

        const newDocRef = await addDoc(collection(db, "announcements"), payload);
        await logAdminAction(db, auth.currentUser, "POST_ANNOUNCEMENT", newDocRef.id, null, { title: title, hasAttachment: !!attachmentUrl });
        
        window.resetAnnounceForm();
        showStatusAlert('statusMessage', 'Announcement posted!', true); 
    } catch (e) {
        console.error(e);
        showStatusAlert('statusMessage', "Failed to post: " + e.message, false); 
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="send" class="size-3 me-2"></i>Post Now`;
        lucide.createIcons();
    }
};

window.resetAnnounceForm = () => { 
    document.getElementById('announceTitle').value = ""; 
    document.getElementById('announceText').value = ""; 
    window.clearAnnounceFile();
};

window.deleteAnnouncement = async (id) => { 
    if (confirm("Delete this announcement?")) {
        showLoading(); 
        try {
            const oldSnap = await getDoc(doc(db, "announcements", id));
            await deleteDoc(doc(db, "announcements", id)); 
            await logAdminAction(db, auth.currentUser, "DELETE_ANNOUNCEMENT", id, oldSnap.data(), null);
            hideLoading(); 
            showStatusAlert('statusMessage', 'Announcement deleted.', true); 
        } catch (e) {
            hideLoading();
            showStatusAlert('statusMessage', 'Error deleting announcement.', false);
        }
    }
};

// --- 🟢 Driver Setup ---
let allStaffCache = [];
window.openDriverSetupModal = async () => {
    driverModal.show();
    const snap = await getDocs(query(collection(db, "users"), where("role", "in", ["staff", "admin"])));
    allStaffCache = snap.docs.map(d => ({id: d.id, ...d.data()})).filter(s => s.status !== 'disabled');
    window.renderDriverSetupList(allStaffCache);
};

window.renderDriverSetupList = (list) => {
    document.getElementById('driverSetupList').innerHTML = list.map(s => `
        <div class="d-flex align-items-center justify-content-between p-3 border-bottom">
            <div><b>${s.personal?.name || s.name}</b><br><small>${s.personal?.email || ''}</small></div>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" onchange="window.toggleDriverStatus('${s.id}', this.checked)" ${s.isDriver ? 'checked' : ''}></div>
        </div>`).join('');
};

window.toggleDriverStatus = async (uid, isDriver) => { 
    await updateDoc(doc(db, "users", uid), { isDriver, updatedAt: serverTimestamp() }); 
    await logAdminAction(db, auth.currentUser, "TOGGLE_DRIVER_STATUS", uid, { isDriver: !isDriver }, { isDriver: isDriver });
};

function initDashboard() {
    document.getElementById('attDate').innerText = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' });
    loadAttendanceStats();
    loadAllTasks(); 
    loadTrackingStats();
    setupAnnounceFileListener();
}

window.viewPhoto = (url) => { 
    if (url.includes('.pdf') || url.includes('alt=media')) {
        window.open(url, '_blank');
    } else {
        document.getElementById('modalImg').src = url; 
        if (photoModal) photoModal.show(); 
    }
};