import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { 
    getFirestore, collection, getDocs, query, where, doc, updateDoc, 
    deleteDoc, onSnapshot, writeBatch, serverTimestamp, getDoc, 
    runTransaction, Timestamp 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";
import { requireAdmin } from "./auth-guard.js";
import { formatTime, msToHM, normalizeDate, logAdminAction, showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let schedulesMap = {}; 
let leavesMap = {};
let usersMap = {};
let holidaysMap = {}; 
let docIdToAuthMap = {}; 
let attendanceData = []; 
let currentMode = 'day'; 

let photoModal, manualActionModal, editRecordModal, bulkVerifyModalInst, monthlyReportModalInst, bulkManualActionModalInst; 
let unsubscribeAttendance = null; 
let unverifiedRecordsCache = []; 

function getLocalTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function initAttendanceApp() {
    document.getElementById('loadingText').innerText = "Loading Attendance...";
    
    if (typeof bootstrap !== 'undefined') {
        photoModal = new bootstrap.Modal(document.getElementById('photoModal'));
        manualActionModal = new bootstrap.Modal(document.getElementById('manualActionModal'));
        editRecordModal = new bootstrap.Modal(document.getElementById('editRecordModal'));
        bulkVerifyModalInst = new bootstrap.Modal(document.getElementById('bulkVerifyModal')); 
        monthlyReportModalInst = new bootstrap.Modal(document.getElementById('monthlyReportModal')); 
        bulkManualActionModalInst = new bootstrap.Modal(document.getElementById('bulkManualActionModal')); 
    }

    const urlParams = new URLSearchParams(window.location.search);
    const urlDate = urlParams.get('date');
    const urlFilter = urlParams.get('filter');
    const urlTab = urlParams.get('tab');

    const todayStr = getLocalTodayStr();
    document.getElementById('dateFilter').value = urlDate || todayStr;
    document.getElementById('monthFilter').value = (urlDate || todayStr).substring(0,7);

    if (urlFilter) {
        const filterEl = document.getElementById('dayStatusFilter');
        if (filterEl) filterEl.value = urlFilter;
    }

    if (urlTab) {
        const tabBtn = document.getElementById(`tab-${urlTab}`);
        if (tabBtn && typeof bootstrap !== 'undefined') {
            const tab = new bootstrap.Tab(tabBtn);
            tab.show();
        }
    }

    const exportBtn = document.getElementById('btnExportMonthlyExcel');
    if (exportBtn) exportBtn.addEventListener('click', exportMonthlyReportToExcel);

    await fetchHolidays(); 
    await fetchUsers();
    window.loadData();
    listenToCorrections();
}

async function fetchHolidays() {
    try {
        const snap = await getDoc(doc(db, "settings", "holidays"));
        if (snap.exists() && snap.data().holiday_list) {
            snap.data().holiday_list.forEach(h => { holidaysMap[h.date] = h.name; });
        }
    } catch(e) { console.error("Error loading holidays:", e); }
}

async function fetchUsers() {
    const snap = await getDocs(query(collection(db, "users")));
    snap.forEach(docSnap => {
        const d = docSnap.data();
        if (d.authUid) docIdToAuthMap[docSnap.id] = d.authUid;
        const key = d.authUid || docSnap.id;
        usersMap[key] = {
            name: d.personal?.name || d.name || "Unknown Staff",
            photo: d.faceIdPhoto || null,
            email: d.personal?.email,
            status: d.status || 'active',
            role: d.role || 'staff',
            docId: docSnap.id,
            authUid: d.authUid,
            empCode: d.personal?.empCode || d.empCode || d.staffId || "" 
        };
    });
}

window.loadData = async function() {
    document.getElementById('loadingState').classList.remove('d-none');
    document.getElementById('emptyState').classList.add('d-none');

    try {
        let startDate, endDate;
        if (currentMode === 'day') {
            startDate = document.getElementById('dateFilter').value;
            endDate = startDate;
        } else {
            const mVal = document.getElementById('monthFilter').value;
            startDate = mVal + "-01";
            endDate = mVal + "-" + new Date(mVal.split('-')[0], mVal.split('-')[1], 0).getDate();
        }

        const [schedSnap, leaveSnap] = await Promise.all([
            getDocs(query(collection(db, "schedules"), where("date", ">=", startDate), where("date", "<=", endDate))),
            getDocs(query(collection(db, "leaves"), where("status", "==", "Approved"), where("endDate", ">=", startDate)))
        ]);

        schedulesMap = {};
        schedSnap.forEach(d => {
            const data = d.data();
            const eUid = docIdToAuthMap[data.userId] || data.userId;
            schedulesMap[eUid + "_" + normalizeDate(data.date)] = { id: d.id, ...data };
        });

        leavesMap = {};
        leaveSnap.forEach(d => {
            const data = d.data();
            const eUid = data.authUid || docIdToAuthMap[data.uid] || data.uid;
            
            const [sY, sM, sD] = data.startDate.split('-');
            const [eY, eM, eD] = data.endDate.split('-');
            let curr = new Date(sY, sM - 1, sD);
            const endD = new Date(eY, eM - 1, eD);
            
            while(curr <= endD) {
                const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
                if(dStr >= startDate && dStr <= endDate) {
                    leavesMap[eUid + "_" + dStr] = data; 
                }
                curr.setDate(curr.getDate() + 1);
            }
        });

        if (unsubscribeAttendance) unsubscribeAttendance();

        const attQuery = query(collection(db, "attendance"), where("date", ">=", startDate), where("date", "<=", endDate));
        unsubscribeAttendance = onSnapshot(attQuery, (attSnap) => {
            processAndRenderAttendance(attSnap, startDate, endDate);
        }, (error) => console.error("Error listening to attendance:", error));

    } catch(e) { 
        console.error(e); 
        hideLoading();
        showStatusAlert('statusMessage', 'Failed to load data.', false);
    }
};

function processAndRenderAttendance(attSnap, startDate, endDate) {
    const listContainer = document.getElementById('attendanceList');
    listContainer.innerHTML = '';
    const currentTodayStr = getLocalTodayStr();

    attendanceData = [];
    let presentUids = new Set();
    let unverified = 0;
    let missingOutData = []; 
    unverifiedRecordsCache = []; 
    
    attSnap.forEach(d => {
        const data = d.data();
        let eUid = usersMap[data.uid] ? data.uid : docIdToAuthMap[data.uid];
        
        if(eUid && !['Rejected', 'Archived'].includes(data.verificationStatus)) {
            const record = { id: d.id, ...data, uid: eUid, date: normalizeDate(data.date) };
            attendanceData.push(record);
            if(currentMode === 'day') presentUids.add(eUid);
            if(data.verificationStatus !== 'Verified') unverified++;
        }
    });

    document.getElementById('tabVerifyBadge').innerText = unverified;
    document.getElementById('tabVerifyBadge').classList.toggle('d-none', unverified === 0);
    document.getElementById('loadingState').classList.add('d-none');

    const grouped = {};
    attendanceData.forEach(r => { if(!grouped[r.uid]) grouped[r.uid] = []; grouped[r.uid].push(r); });

    const dayFilterEl = document.getElementById('dayStatusFilter');
    const dayFilter = dayFilterEl ? dayFilterEl.value : 'all';
    let recordsToRender = [];

    const targetDate = normalizeDate(startDate);

    if(currentMode === 'day') {
         Object.keys(usersMap).forEach(uid => {
             if(usersMap[uid].status === 'disabled') return;

             const dayRecords = grouped[uid] || [];
             const hasIn = dayRecords.some(r => r.session === 'Clock In');
             const hasOut = dayRecords.some(r => r.session === 'Clock Out');
             const hasUnverified = dayRecords.some(r => r.verificationStatus !== 'Verified');
             
             const isMissingOut = hasIn && !hasOut && (targetDate < currentTodayStr);

             const sched = schedulesMap[uid + "_" + targetDate];
             let leaveObj = leavesMap[uid + "_" + targetDate];
             let leave = leaveObj ? leaveObj.type : null;
             let duration = leaveObj?.duration || 'Full Day';
             
             const isPH = !!holidaysMap[targetDate] && (!!sched || !!leave);
             if (isPH) leave = null; 
             
             const isAbsent = (targetDate <= currentTodayStr) && !hasIn && sched && (!leave || duration !== 'Full Day') && !isPH;

             if (isMissingOut) missingOutData.push(usersMap[uid].name);

             let showUser = false;
             if (dayFilter === 'all') showUser = true;
             else if (dayFilter === 'clockedIn' && hasIn) showUser = true; 
             else if (dayFilter === 'unverified' && hasUnverified) showUser = true;
             else if (dayFilter === 'missingOut' && isMissingOut) showUser = true;
             else if (dayFilter === 'absent' && isAbsent) showUser = true;

             if (showUser) {
                 recordsToRender.push(uid);
                 dayRecords.forEach(r => {
                     if (r.verificationStatus !== 'Verified') unverifiedRecordsCache.push(r);
                 });
             }
         });
    }

    let count = 0;
    const sortedUids = Object.keys(usersMap).sort((a,b) => usersMap[a].name.localeCompare(usersMap[b].name));

    if(currentMode === 'day') {
        recordsToRender.sort((a,b) => usersMap[a].name.localeCompare(usersMap[b].name)).forEach(uid => {
            if(renderDayUserCard(uid, grouped[uid] || [], listContainer, targetDate, currentTodayStr)) count++; 
        });
        renderDashboard(attendanceData, presentUids, missingOutData);

        const bulkBtn = document.getElementById('bulkVerifyBtn');
        if (bulkBtn) {
            if (unverifiedRecordsCache.length > 0) {
                bulkBtn.classList.remove('d-none');
                bulkBtn.innerHTML = `<i data-lucide="check-circle" class="size-4"></i> Bulk Verify (${unverifiedRecordsCache.length})`;
            } else {
                bulkBtn.classList.add('d-none');
            }
        }
    } else {
        sortedUids.forEach(uid => { 
            if(usersMap[uid].status !== 'disabled' && renderMonthUserCard(uid, grouped[uid] || [], listContainer, null, currentTodayStr)) count++; 
        });
        
        const bulkBtn = document.getElementById('bulkVerifyBtn');
        if(bulkBtn) bulkBtn.classList.add('d-none'); 
    }
    
    if(count === 0 && recordsToRender.length === 0) document.getElementById('emptyState').classList.remove('d-none');
    else document.getElementById('emptyState').classList.add('d-none');
    
    hideLoading();
    document.getElementById('mainContainer').classList.remove('d-none');
    
    if (window.lucide) window.lucide.createIcons();
}

function renderDayUserCard(uid, records, container, targetDate, currentTodayStr) {
    const user = usersMap[uid];
    const sched = schedulesMap[uid + "_" + targetDate];
    let leaveObj = leavesMap[uid + "_" + targetDate];
    let leave = leaveObj ? leaveObj.type : null;
    let duration = leaveObj?.duration || 'Full Day';
    
    const isPH = !!holidaysMap[targetDate] && (!!sched || !!leave); 
    if (isPH) leave = null; 
    
    if (!sched && records.length === 0 && !leave && !isPH) return false;

    let inT = "--:--", outT = "--:--", pending = 0;
    
    records.sort((a,b) => {
        const ta = a.timestamp?.toDate ? a.timestamp.toDate() : new Date();
        const tb = b.timestamp?.toDate ? b.timestamp.toDate() : new Date();
        return ta - tb;
    });

    records.forEach(r => {
        if(r.verificationStatus !== 'Verified') pending++;
        if(r.session === 'Clock In' && inT === "--:--") inT = formatTime(r.timestamp);
        if(r.session === 'Clock Out') outT = formatTime(r.timestamp);
    });

    const isAbsent = (targetDate <= currentTodayStr) && inT === "--:--" && sched && (!leave || duration !== 'Full Day') && !isPH; 
    const isMissingOut = inT !== "--:--" && outT === "--:--" && targetDate < currentTodayStr;
    const isClockedInToday = inT !== "--:--" && outT === "--:--" && targetDate === currentTodayStr;

    const card = document.createElement('div');
    card.className = `user-card user-card-container ${isAbsent ? 'row-absent' : (leave ? 'row-leave' : '')}`;
    card.setAttribute('data-name', user.name);
    
    let statusColor = "bg-secondary";
    if (isAbsent) statusColor = "bg-danger";
    else if (isPH && inT === "--:--") statusColor = "bg-warning";
    else if (isMissingOut) statusColor = "bg-danger";
    else if (isClockedInToday) statusColor = "bg-warning";
    else if (pending > 0) statusColor = "bg-warning";
    else if (inT !== "--:--") statusColor = "bg-success";
    else if (leave) statusColor = "bg-info";

    let statusLabel = "";
    if (isAbsent) statusLabel += `<span class="badge bg-danger me-1">ABSENT</span>`;
    else if (isMissingOut) statusLabel += `<span class="badge bg-danger me-1">MISSING OUT</span>`;
    else if (isClockedInToday) statusLabel += `<span class="badge bg-warning text-dark me-1">CLOCKED IN</span>`;
    else if (inT !== "--:--") statusLabel += `<span class="badge bg-success me-1">PRESENT</span>`;

    if (isPH && inT === "--:--") statusLabel += `<span class="badge bg-warning text-dark border me-1"><i data-lucide="star" class="size-3 me-1"></i> PUBLIC HOLIDAY</span>`;
    else if (isPH && inT !== "--:--") statusLabel += `<span class="badge bg-warning text-dark ms-1">PH (3x)</span>`;

    if (leave) {
        let lText = leave.toUpperCase();
        if (duration !== 'Full Day') lText += ` (${duration.replace('Half Day ', '')})`;
        statusLabel += `<span class="badge bg-info text-dark">${lText}</span>`;
    }

    card.innerHTML = `
        <div class="card-header-custom collapsed" data-bs-toggle="collapse" data-bs-target="#collapse-${uid}">
            <div class="row align-items-center">
                <div class="col-md-4 d-flex align-items-center gap-3 border-end border-light">
                    <div class="position-relative">
                        ${user.photo ? `<img src="${user.photo}" class="staff-avatar">` : `<div class="staff-avatar">${user.name.charAt(0)}</div>`}
                        <span class="position-absolute top-0 start-100 translate-middle p-1 border border-light rounded-circle ${statusColor}"></span>
                    </div>
                    <div>
                        <h6 class="fw-bold text-dark m-0 text-truncate" style="max-width:150px">${user.name}</h6>
                        <div class="d-flex align-items-center mt-1">
                            ${user.empCode ? `<span class="badge bg-light text-secondary border border-secondary-subtle me-2 px-1 py-0" style="font-size: 0.65rem;">${user.empCode}</span>` : ''}
                            <small class="text-muted" style="font-size: 0.7rem;">Shift: ${sched?formatTime(sched.start)+'-'+formatTime(sched.end):'Off'}</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-5"><div class="row text-center"><div class="col-6"><div class="stat-label">In</div><div class="stat-value font-monospace">${inT}</div></div><div class="col-6"><div class="stat-label">Out</div><div class="stat-value text-success font-monospace">${outT}</div></div></div></div>
                <div class="col-md-3 text-end d-flex align-items-center justify-content-end gap-2">
                    ${statusLabel}
                    ${pending > 0 ? `<span class="badge bg-warning text-dark">${pending}</span>` : ''}
                    <button class="btn btn-sm btn-light border-0" onclick="window.openManualAction('${uid}', '${targetDate}'); event.stopPropagation();"><i data-lucide="settings-2" class="size-4"></i></button>
                    <i data-lucide="chevron-down" class="text-muted chevron-icon"></i>
                </div>
            </div>
        </div>
        <div id="collapse-${uid}" class="collapse"><div class="list-group list-group-flush">${records.map(r => renderRecordItem(r)).join('')}</div></div>`;
    container.appendChild(card);
    return true;
}

function renderMonthUserCard(uid, allRecords, container, filterType, currentTodayStr) {
    const user = usersMap[uid];
    const mVal = document.getElementById('monthFilter').value;
    const [y, m] = mVal.split('-');
    const days = new Date(y, m, 0).getDate();
    
    let present = 0;
    let scheduledCount = 0; 
    let rowsHtml = "";

    for(let d=1; d<=days; d++) {
        const dateStr = `${y}-${m}-${d.toString().padStart(2,'0')}`;
        const sched = schedulesMap[uid + "_" + dateStr];
        const isPH = !!holidaysMap[dateStr] && !!sched; 
        
        let leaveObj = leavesMap[uid + "_" + dateStr];
        let leave = leaveObj ? leaveObj.type : null;
        let duration = leaveObj?.duration || 'Full Day';
        if (isPH) leave = null;

        const dayRecords = allRecords.filter(r => r.date === dateStr && r.verificationStatus === 'Verified');
        if (sched) scheduledCount++;

        let inT = null;
        let hasOut = false;
        dayRecords.forEach(r => { 
            if(r.session === 'Clock In') inT = formatTime(r.timestamp); 
            if(r.session === 'Clock Out') hasOut = true; 
        });

        let isML = leave && (leave.includes('Medical') || leave.includes('病假') || leave.includes('Cuti Sakit'));
        let isAL = leave && (leave.includes('Annual') || leave.includes('年假') || leave.includes('Cuti Tahunan'));
        let isHalfDay = duration !== 'Full Day';
        
        if(inT || isPH) {
            present += 1;
        } else if (isML || isAL) {
            present += isHalfDay ? 0.5 : 1;
        }

        if (dayRecords.length > 0 || sched || leave || isPH) {
            let statusHtml = '';

            if (isPH && !inT) statusHtml = `<span class="badge bg-warning text-dark border border-warning-subtle">PUBLIC HOLIDAY</span>`;
            else if (isPH && inT) statusHtml = `<b>Worked <span class="text-warning">(3x PH)</span></b>`;
            else if (inT && !hasOut && dateStr < currentTodayStr) statusHtml = '<span class="text-danger fw-bold">MISSING OUT</span>';
            else if (inT && leave) {
                let lText = leave.toUpperCase();
                if (isHalfDay) lText += ` (${duration.replace('Half Day ', '')})`;
                statusHtml = `<b>Verified Present</b> <span class="text-info small fw-bold ms-1">+ ${lText}</span>`;
            }
            else if (inT) statusHtml = '<b>Verified Present</b>';
            else if (leave && !inT) {
                let lText = leave.toUpperCase();
                if (isHalfDay) lText += ` (${duration.replace('Half Day ', '')})`;
                if (isHalfDay && sched) {
                    statusHtml = `<span class="text-danger fw-bold me-2">ABSENT</span> <span class="text-info fw-bold">${lText}</span>`;
                } else {
                    statusHtml = `<span class="text-info fw-bold">${lText}</span>`;
                }
            }
            else if (dateStr <= currentTodayStr && sched) statusHtml = '<span class="text-danger fw-bold">ABSENT</span>';
            else statusHtml = 'Off';

            rowsHtml += `<li class="inner-list-item d-flex justify-content-between">
                <div><span class="badge badge-soft-secondary text-mono me-3">${dateStr}</span></div>
                <div class="text-end">${statusHtml}</div>
            </li>`;
        }
    }

    const card = document.createElement('div');
    card.className = 'user-card user-card-container'; card.setAttribute('data-name', user.name);
    card.innerHTML = `
        <div class="card-header-custom collapsed" data-bs-toggle="collapse" data-bs-target="#collapse-month-${uid}">
            <div class="row align-items-center">
                <div class="col-4 d-flex align-items-center gap-3">
                    ${user.photo?`<img src="${user.photo}" class="staff-avatar">`:`<div class="staff-avatar">${user.name.charAt(0)}</div>`}
                    <div>
                        <h6 class="fw-bold m-0">${user.name}</h6>
                        ${user.empCode ? `<small class="text-muted fw-bold d-block mt-1" style="font-size: 0.65rem;"><span class="badge bg-light text-secondary border border-secondary-subtle px-1 py-0">${user.empCode}</span></small>` : ''}
                    </div>
                </div>
                <div class="col-7 text-center">
                    <div class="stat-label">Days Present</div>
                    <div class="stat-value">${present} / ${scheduledCount}</div>
                </div>
                <div class="col-1 text-end"><i data-lucide="chevron-down" class="text-muted chevron-icon"></i></div>
            </div>
        </div>
        <div id="collapse-month-${uid}" class="collapse"><ul class="list-group list-group-flush">${rowsHtml}</ul></div>`;
    container.appendChild(card);
    return true;
}

function renderRecordItem(item) {
    const isV = item.verificationStatus === 'Verified';
    const time = formatTime(item.timestamp);
    const tEdit = item.timestamp?.toDate ? item.timestamp.toDate().toTimeString().slice(0,5) : "";
    
    const isAuto = item.address === "System Auto Clock Out";
    const sessionDisplay = isAuto ? `<span class="text-danger fw-bold"><i data-lucide="zap" class="size-3"></i> Auto Clock Out</span>` : `<div class="fw-bold text-muted">${item.session}</div>`;
    
    return `<div class="list-group-item d-flex justify-content-between align-items-center px-4 py-2 ${isAuto ? 'bg-danger bg-opacity-10' : ''}">
        <div class="small">${sessionDisplay}<div class="fw-bold text-dark">${time}</div>${isAuto ? '<small class="text-danger">Forced by System</small>' : ''}</div>
        <div class="text-end d-flex align-items-center gap-3">
            ${isV ? '<span class="badge bg-success bg-opacity-10 text-success border border-success">Verified</span>' : `<button class="btn btn-xs btn-primary" onclick="window.quickVerify('${item.id}')">Verify</button>`}
            <button class="btn btn-xs btn-light border" onclick="window.openEditRecord('${item.id}', '${item.session}', '${tEdit}', '${item.date}')"><i data-lucide="edit-3" class="size-3"></i></button>
            ${item.photoUrl ? `<button class="btn btn-xs btn-outline-info" onclick="window.viewPhoto('${item.photoUrl}')"><i data-lucide="image" class="size-3"></i></button>` : ''}
        </div>
    </div>`;
}

function renderDashboard(data, pUids, missingOutData = []) {
    const target = document.getElementById('dateFilter').value;
    let scheduled=0, leave=0, absent=0;
    const aList = [];
    Object.keys(usersMap).forEach(uid => {
        if(usersMap[uid].status === 'disabled') return;

        const sched = schedulesMap[uid+"_"+target];
        let leaveObj = leavesMap[uid+"_"+target];
        let leaveType = leaveObj ? leaveObj.type : null;
        
        let duration = leaveObj?.duration || 'Full Day';

        if (sched) scheduled++;

        const isPH = !!holidaysMap[target] && (!!sched || !!leaveType);
        
        if(isPH || leaveType) {
            leave++; 
            if (duration !== 'Full Day' && sched && !pUids.has(uid)) {
                absent++;
                aList.push(`${usersMap[uid].name} <span class="text-warning small ms-2 border px-1 rounded">(Missing Half)</span>`);
            }
        } else if(sched && !pUids.has(uid)) { 
            absent++; 
            aList.push(usersMap[uid].name); 
        }
    });
    
    document.getElementById('statTotalStaff').innerText = scheduled;
    document.getElementById('statPresent').innerText = pUids.size;
    document.getElementById('statAbsent').innerText = absent;
    document.getElementById('statLeave').innerText = leave;
    document.getElementById('absentList').innerHTML = aList.map(n => `<li class="list-group-item d-flex justify-content-between align-items-center fw-bold">${n} <span class="badge bg-danger">ABSENT</span></li>`).join('') || '<li class="list-group-item text-center text-success py-3">All scheduled staff accounted for.</li>';

    const lateListContainer = document.getElementById('lateList');
    if (missingOutData.length > 0) {
        let warningHtml = missingOutData.map(n => 
            `<li class="list-group-item d-flex justify-content-between align-items-center fw-bold text-warning" style="background-color: #fffbeb;">
                ${n} 
                <span class="badge bg-warning text-dark"><i data-lucide="alert-triangle" class="size-3 me-1"></i> Missing Out</span>
            </li>`
        ).join('');
        lateListContainer.innerHTML = warningHtml;
    } else {
        lateListContainer.innerHTML = '<li class="list-group-item text-center text-muted py-3">No anomalies detected.</li>';
    }
}

window.bulkVerify = () => {
    if (unverifiedRecordsCache.length === 0) {
        alert("No unverified records available.");
        return;
    }

    const groupedData = {};
    unverifiedRecordsCache.forEach(record => {
        if (!groupedData[record.uid]) {
            const user = usersMap[record.uid] || {};
            groupedData[record.uid] = {
                name: user.name || "Unknown Staff",
                empCode: user.empCode || `EMP-${record.uid.substring(0, 5).toUpperCase()}`,
                records: []
            };
        }
        groupedData[record.uid].records.push(record);
    });

    const tbody = document.getElementById('bulkVerifyListBody');
    tbody.innerHTML = '';

    Object.values(groupedData).forEach(emp => {
        let cin = '--:--', cout = '--:--', bout = '--:--', bin = '--:--';
        
        emp.records.forEach(r => {
            const timeStr = r.timestamp ? formatTime(r.timestamp) : "--:--";
            if (r.session === 'Clock In') cin = timeStr;
            else if (r.session === 'Clock Out') cout = timeStr;
            else if (r.session === 'Break Out') bout = timeStr;
            else if (r.session === 'Break In') bin = timeStr;
        });

        tbody.innerHTML += `
            <tr>
                <td class="text-start ps-4">
                    <div class="fw-bold text-dark">${emp.empCode}</div>
                    <div class="small text-muted">${emp.name}</div>
                </td>
                <td><span class="badge ${cin !== '--:--' ? 'bg-success bg-opacity-10 text-success border border-success' : 'bg-light text-muted border'}">${cin}</span></td>
                <td><span class="badge ${bout !== '--:--' ? 'bg-warning bg-opacity-10 text-warning border border-warning' : 'bg-light text-muted border'}">${bout}</span></td>
                <td><span class="badge ${bin !== '--:--' ? 'bg-info bg-opacity-10 text-info border border-info' : 'bg-light text-muted border'}">${bin}</span></td>
                <td><span class="badge ${cout !== '--:--' ? 'bg-success bg-opacity-10 text-success border border-success' : 'bg-light text-muted border'}">${cout}</span></td>
            </tr>
        `;
    });

    document.getElementById('bulkVerifyTotalCount').innerText = `Total: ${unverifiedRecordsCache.length} pending records`;
    bulkVerifyModalInst.show();
};

window.confirmBulkVerify = async () => {
    showLoading();
    try {
        const batch = writeBatch(db);
        unverifiedRecordsCache.forEach(record => {
            const recordRef = doc(db, "attendance", record.id);
            batch.update(recordRef, { verificationStatus: "Verified" });
        });

        await batch.commit();
        bulkVerifyModalInst.hide();
        showStatusAlert('statusMessage', `Successfully verified ${unverifiedRecordsCache.length} records!`, true);
    } catch (e) {
        bulkVerifyModalInst.hide();
        hideLoading();
        showStatusAlert('statusMessage', `Bulk verification failed: ${e.message}`, false);
    }
};

window.openManualAction = (uid, targetDate) => {
    document.getElementById('manualUid').value = uid;
    document.getElementById('manualDate').value = targetDate;
    document.getElementById('manualActionType').value = "";
    document.getElementById('manualReason').value = "";
    
    document.getElementById('manualSingleTime').value = "";
    document.getElementById('manualClockIn').value = "";
    document.getElementById('manualClockOut').value = "";
    document.getElementById('manualBreakOut').value = "";
    document.getElementById('manualBreakIn').value = "";

    const sched = schedulesMap[uid + "_" + targetDate];
    if (sched) {
        if (sched.start) {
            const startD = sched.start.toDate();
            const sh = startD.getHours().toString().padStart(2, '0');
            const sm = startD.getMinutes().toString().padStart(2, '0');
            document.getElementById('manualClockIn').value = `${sh}:${sm}`;
        }
        if (sched.end) {
            const endD = sched.end.toDate();
            const eh = endD.getHours().toString().padStart(2, '0');
            const em = endD.getMinutes().toString().padStart(2, '0');
            document.getElementById('manualClockOut').value = `${eh}:${em}`;
        }
    }
    
    window.toggleManualInputs();
    manualActionModal.show();
}

window.toggleManualInputs = () => {
    const type = document.getElementById('manualActionType').value;
    
    const isSingleAdd = ['Add Clock In', 'Add Break Out', 'Add Break In', 'Add Clock Out'].includes(type);
    const isFullOverwrite = type === 'Overwrite Full Day';
    const willArchive = ['Overwrite Full Day', 'Absent'].includes(type) || type.includes('Leave');

    document.getElementById('boxSingleTime').classList.toggle('d-none', !isSingleAdd);
    document.getElementById('boxPresent').classList.toggle('d-none', !isFullOverwrite);
    document.getElementById('boxLeave').classList.toggle('d-none', !type.includes('Leave'));
    document.getElementById('archiveWarning').classList.toggle('d-none', !willArchive);

    if (isSingleAdd) {
        document.getElementById('singleTimeLabel').innerText = `Enter ${type.replace('Add ', '')} Time`;
    }
};

window.submitManualAction = async () => {
    const uid = document.getElementById('manualUid').value;
    const dateStr = document.getElementById('manualDate').value;
    const type = document.getElementById('manualActionType').value;
    const userObj = usersMap[uid];
    if(!type || !confirm(`Confirm ${type} for ${userObj.name}?`)) return;

    showLoading(); 

    try {
        const batch = writeBatch(db);
        
        const q = query(collection(db, "attendance"), where("uid", "==", userObj.authUid || userObj.docId), where("date", "==", dateStr));
        const snap = await getDocs(q);
        const oldDataSnapshot = [];
        snap.forEach(d => oldDataSnapshot.push({id: d.id, ...d.data()}));

        const shouldArchive = ['Overwrite Full Day', 'Absent'].includes(type) || type.includes('Leave');
        if (shouldArchive) {
            snap.forEach(d => batch.update(d.ref, { verificationStatus: "Archived" }));
        }

        const base = { 
            uid: userObj.authUid || userObj.docId, 
            name: userObj.name, 
            email: userObj.email, 
            date: dateStr, 
            verificationStatus: "Verified", 
            address: "Admin Manual Entry", 
        };

        if (['Add Clock In', 'Add Break Out', 'Add Break In', 'Add Clock Out'].includes(type)) {
            const t = document.getElementById('manualSingleTime').value;
            if(!t) throw new Error("Please enter a valid time.");
            
            const sessionType = type.replace('Add ', ''); 
            const preciseDate = new Date(`${dateStr}T${t}:00`);
            
            const newDocData = { 
                ...base, 
                session: sessionType, 
                timestamp: Timestamp.fromDate(preciseDate)
            };
            batch.set(doc(collection(db, "attendance")), newDocData);
            
            await logAdminAction(db, auth.currentUser, type.toUpperCase().replace(/ /g, '_'), userObj.docId, oldDataSnapshot, newDocData);
            await batch.commit();

        } else if (type === 'Overwrite Full Day') {
            const cin = document.getElementById('manualClockIn').value;
            const bout = document.getElementById('manualBreakOut').value;
            const bin = document.getElementById('manualBreakIn').value;
            const cout = document.getElementById('manualClockOut').value;
            
            if(cin) {
                const preciseIn = new Date(`${dateStr}T${cin}:00`);
                batch.set(doc(collection(db, "attendance")), { ...base, session: "Clock In", timestamp: Timestamp.fromDate(preciseIn) });
            }
            if(bout) {
                const preciseBout = new Date(`${dateStr}T${bout}:00`);
                batch.set(doc(collection(db, "attendance")), { ...base, session: "Break Out", timestamp: Timestamp.fromDate(preciseBout) });
            }
            if(bin) {
                const preciseBin = new Date(`${dateStr}T${bin}:00`);
                batch.set(doc(collection(db, "attendance")), { ...base, session: "Break In", timestamp: Timestamp.fromDate(preciseBin) });
            }
            if(cout) {
                const preciseOut = new Date(`${dateStr}T${cout}:00`);
                batch.set(doc(collection(db, "attendance")), { ...base, session: "Clock Out", timestamp: Timestamp.fromDate(preciseOut) });
            }
            
            await logAdminAction(db, auth.currentUser, "MANUAL_OVERWRITE_FULL_DAY", userObj.docId, oldDataSnapshot, { cin, bout, bin, cout, date: dateStr });
            await batch.commit();

        } else if (type === 'Absent') {
            const leaveRef = doc(collection(db, "leaves"));
            const leaveData = { 
                uid: userObj.docId, 
                authUid: userObj.authUid, 
                empName: userObj.name, 
                type: 'Absent', 
                startDate: dateStr, 
                endDate: dateStr, 
                days: 1, 
                duration: 'Full Day',
                status: 'Approved', 
                reviewedAt: serverTimestamp(), 
                isPayrollDeductible: true, 
                reason: document.getElementById('manualReason').value || "Admin Manual Absent" 
            };
            batch.set(leaveRef, leaveData);
            
            await logAdminAction(db, auth.currentUser, "MANUAL_ATTENDANCE_ABSENT", userObj.docId, oldDataSnapshot, leaveData);
            await batch.commit();

        } else if (type.includes('Leave')) {
            await batch.commit(); 
            await runTransaction(db, async (tx) => {
                const uRef = doc(db, "users", userObj.docId);
                const uDoc = await tx.get(uRef);
                const oldBal = uDoc.data().leave_balance?.annual || 0;
                
                const eUid = userObj.authUid || userObj.docId;
                const isPH = !!holidaysMap[dateStr] && !!schedulesMap[eUid+"_"+dateStr];
                const deductAmt = isPH ? 0 : 1; 

                if(type === 'Annual Leave' && deductAmt > 0) {
                    tx.update(uRef, { "leave_balance.annual": oldBal - deductAmt });
                }
                
                const leaveData = { 
                    uid: userObj.docId, 
                    authUid: userObj.authUid, 
                    empName: userObj.name, 
                    type, 
                    startDate: dateStr, 
                    endDate: dateStr, 
                    days: 1, 
                    duration: 'Full Day', 
                    deductibleDays: deductAmt, 
                    phOverlap: isPH ? 1 : 0,
                    status: 'Approved', 
                    reviewedAt: serverTimestamp(), 
                    isPayrollDeductible: type === 'Unpaid Leave', 
                    reason: document.getElementById('manualReason').value || "Admin Manual Leave" 
                };
                tx.set(doc(collection(db, "leaves")), leaveData);
                
                await logAdminAction(db, auth.currentUser, "MANUAL_LEAVE_ASSIGN", userObj.docId, {oldBalance: oldBal, oldAttendance: oldDataSnapshot}, leaveData);
            });
        }
        
        manualActionModal.hide(); 
        hideLoading();
        showStatusAlert('statusMessage', 'Record successfully updated.', true); 
    } catch(e) { 
        hideLoading();
        showStatusAlert('statusMessage', `Error: ${e.message}`, false); 
    }
}

window.openEditRecord = (id, type, time, date) => {
    document.getElementById('editDocId').value = id;
    document.getElementById('editSessionType').value = type;
    document.getElementById('editTimeInput').value = time;
    document.getElementById('editRecordDate').value = date;
    editRecordModal.show();
}

window.saveSingleRecord = async () => {
    const id = document.getElementById('editDocId').value;
    const time = document.getElementById('editTimeInput').value;
    const date = document.getElementById('editRecordDate').value;
    const ref = doc(db, "attendance", id);
    
    showLoading(); 
    try {
        const snap = await getDoc(ref);
        const oldData = snap.data();
        const batch = writeBatch(db);
        
        batch.update(ref, { verificationStatus: "Archived" });
        
        const preciseDate = new Date(`${date}T${time}:00`);
        const newRef = doc(collection(db, "attendance"));
        const newData = { ...oldData, verificationStatus: "Verified", address: "Admin Manual Edit", timestamp: Timestamp.fromDate(preciseDate) };
        
        batch.set(newRef, newData);
        
        await logAdminAction(db, auth.currentUser, "EDIT_SINGLE_RECORD", oldData.uid, oldData, newData);
        await batch.commit();
        
        editRecordModal.hide(); 
        hideLoading();
        showStatusAlert('statusMessage', 'Time adjusted successfully.', true);
    } catch(e) { 
        hideLoading();
        showStatusAlert('statusMessage', `Error: ${e.message}`, false); 
    }
}

window.deleteSingleRecord = async () => {
    if(!confirm("Permanently delete this record? This cannot be reverted easily.")) return;
    const id = document.getElementById('editDocId').value;
    
    showLoading();
    try {
        const snap = await getDoc(doc(db, "attendance", id));
        await logAdminAction(db, auth.currentUser, "DELETE_RECORD", snap.data().uid, snap.data(), null);
        await deleteDoc(doc(db, "attendance", id));
        editRecordModal.hide(); 
        hideLoading();
        showStatusAlert('statusMessage', 'Record deleted.', true);
    } catch(e) { 
        hideLoading();
        showStatusAlert('statusMessage', `Error: ${e.message}`, false); 
    }
};

window.quickVerify = async (id) => {
    try {
        await updateDoc(doc(db, "attendance", id), { verificationStatus: "Verified" });
        showStatusAlert('statusMessage', 'Record Verified.', true);
    } catch(e) {
        showStatusAlert('statusMessage', `Error verifying: ${e.message}`, false);
    }
}

window.toggleMode = (mode) => {
    currentMode = mode;
    const dashTabLi = document.getElementById('navItemDashboard');
    if(mode === 'day') {
        document.getElementById('dayControls').classList.remove('d-none');
        document.getElementById('monthControls').classList.add('d-none');
        dashTabLi.classList.remove('month-mode-hidden');
    } else {
        document.getElementById('dayControls').classList.add('d-none');
        document.getElementById('monthControls').classList.remove('d-none');
        dashTabLi.classList.add('month-mode-hidden');
    }
    window.loadData();
}

window.handleSearch = () => {
    const term = document.getElementById('searchInput').value.toLowerCase();
    document.querySelectorAll('.user-card-container').forEach(card => {
        const name = card.getAttribute('data-name').toLowerCase();
        card.style.display = name.includes(term) ? 'block' : 'none';
    });
}

window.changeDate = (days) => { const el = document.getElementById('dateFilter'); const d = new Date(el.value); d.setDate(d.getDate() + days); el.value = d.toISOString().split('T')[0]; window.loadData(); }

function listenToCorrections() {
    onSnapshot(query(collection(db, "attendance_corrections"), where("status", "==", "Pending")), (snap) => {
        const badge = document.getElementById('tabCorrectionBadge');
        badge.innerText = snap.size; badge.classList.toggle('d-none', snap.size === 0);
        const tbody = document.getElementById('correctionListBody');
        tbody.innerHTML = '';
        if(snap.empty) document.getElementById('noCorrectionsMsg').classList.remove('d-none');
        else {
            document.getElementById('noCorrectionsMsg').classList.add('d-none');
            snap.forEach(docSnap => {
                const d = docSnap.data();
                
                const evidenceHtml = d.attachmentUrl 
                    ? `<a href="${d.attachmentUrl}" target="_blank" class="d-inline-block">
                        <img src="${d.attachmentUrl}" class="rounded border shadow-sm" style="width: 40px; height: 40px; object-fit: cover; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'">
                       </a>` 
                    : `<span class="text-muted small">None</span>`;

                tbody.innerHTML += `<tr>
                    <td class="ps-4 fw-medium text-dark">${d.empName || d.email?.split('@')[0]}</td>
                    <td><span class="badge bg-light text-secondary border">${d.targetDate}</span></td>
                    <td class="text-muted">${d.originalIn || '--:--'} <br> ${d.originalOut || '--:--'}</td>
                    <td class="text-primary fw-bold">${d.requestedIn || '--:--'} <br> ${d.requestedOut || '--:--'}</td>
                    
                    <td>
                        <div class="text-truncate text-muted small" title="${d.remarks || ''}">${d.remarks || '-'}</div>
                    </td>
                    
                    <td class="text-center">${evidenceHtml}</td>
                    
                    <td class="text-end pe-4">
                        <button class="btn btn-sm btn-success me-1 shadow-sm" onclick="window.handleCorrection('${docSnap.id}', 'approve')"><i data-lucide="check" class="size-3"></i></button>
                        <button class="btn btn-sm btn-danger shadow-sm" onclick="window.handleCorrection('${docSnap.id}', 'reject')"><i data-lucide="x" class="size-3"></i></button>
                    </td>
                </tr>`;
            });
            if (window.lucide) window.lucide.createIcons();
        }
    });
}

window.handleCorrection = async (correctionId, decision) => {
    if(!confirm(`Confirm ${decision} this correction request?`)) return;
    
    showLoading();
    try {
        const correctionRef = doc(db, "attendance_corrections", correctionId);
        const correctionSnap = await getDoc(correctionRef);
        
        if (!correctionSnap.exists()) throw new Error("Correction request not found.");
        const reqData = correctionSnap.data();

        if (decision === 'approve') {
            const batch = writeBatch(db);
            
            batch.update(correctionRef, { status: "Approved", reviewedAt: serverTimestamp(), reviewer: auth.currentUser.email });
            
            const q = query(collection(db, "attendance"), where("uid", "==", reqData.uid), where("date", "==", reqData.targetDate));
            const oldAttSnap = await getDocs(q);
            
            oldAttSnap.forEach(d => {
                const sessionType = d.data().session;
                if (sessionType === 'Clock In' || sessionType === 'Clock Out') {
                    batch.update(d.ref, { verificationStatus: "Archived" });
                }
            });

            const baseRecord = {
                uid: reqData.uid,
                name: reqData.empName || reqData.email?.split('@')[0] || "Unknown Staff",
                email: reqData.email || "",
                date: reqData.targetDate,
                verificationStatus: "Verified", 
                address: "Approved Correction Request",
            };

            if (reqData.requestedIn && reqData.requestedIn !== '--:--' && reqData.requestedIn !== '-') {
                const preciseInDate = new Date(`${reqData.targetDate}T${reqData.requestedIn}:00`);
                const inRef = doc(collection(db, "attendance"));
                batch.set(inRef, { ...baseRecord, session: "Clock In", timestamp: Timestamp.fromDate(preciseInDate) });
            }

            if (reqData.requestedOut && reqData.requestedOut !== '--:--' && reqData.requestedOut !== '-') {
                const preciseOutDate = new Date(`${reqData.targetDate}T${reqData.requestedOut}:00`);
                const outRef = doc(collection(db, "attendance"));
                batch.set(outRef, { ...baseRecord, session: "Clock Out", timestamp: Timestamp.fromDate(preciseOutDate) });
            }

            await batch.commit();
            await logAdminAction(db, auth.currentUser, "CORRECTION_APPROVE", reqData.uid, null, reqData);

        } else {
            await updateDoc(correctionRef, { status: "Rejected", reviewedAt: serverTimestamp(), reviewer: auth.currentUser.email });
            await logAdminAction(db, auth.currentUser, "CORRECTION_REJECT", reqData.uid, null, reqData);
        }
        
        hideLoading();
        showStatusAlert('statusMessage', `Correction ${decision}d successfully.`, true);
        
        window.loadData(); 
        
    } catch (e) {
        hideLoading();
        showStatusAlert('statusMessage', `Error: ${e.message}`, false);
    }
}
window.viewPhoto = (url) => {
    document.getElementById('modalImg').src = url;
    photoModal.show();
};

// ----------------------------------------------------
// 🟢 月度报表与总工时计算 (Monthly Report) 
// ----------------------------------------------------

window.openMonthlyReportModal = () => {
    const staffSelect = document.getElementById('reportStaffSelect');
    staffSelect.innerHTML = '<option value="">-- Select Staff --</option>';

    const userList = Object.values(usersMap).sort((a, b) => a.name.localeCompare(b.name));

    userList.forEach(u => {
        if (u.status !== 'disabled' && u.role !== 'manager') {
           staffSelect.innerHTML += `<option value="${u.authUid || u.docId}">[${u.docId || 'N/A'}] ${u.name}</option>`;
        }
    });

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    document.getElementById('reportMonthInput').value = `${yyyy}-${mm}`;

    document.getElementById('monthlyReportBody').innerHTML = '<tr><td colspan="6" class="text-center text-muted py-5">Please select a staff and month to generate the report.</td></tr>';
    document.getElementById('monthlyReportFooter').style.display = 'none';

    monthlyReportModalInst.show();
    if (window.lucide) window.lucide.createIcons();
};

window.generateMonthlyReport = async () => {
    const uid = document.getElementById('reportStaffSelect').value;
    const monthVal = document.getElementById('reportMonthInput').value;

    if (!uid || !monthVal) {
        alert("Please select both a staff member and a month.");
        return;
    }

    const tbody = document.getElementById('monthlyReportBody');
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-5"><div class="spinner-border text-primary" role="status"></div><div class="mt-2 text-muted small">Crunching numbers...</div></td></tr>';
    document.getElementById('monthlyReportFooter').style.display = 'none';

    try {
        const startDate = `${monthVal}-01`;
        const [yyyy, mm] = monthVal.split('-');
        const daysInMonth = new Date(yyyy, mm, 0).getDate();
        const endDate = `${monthVal}-${daysInMonth}`; 

        const q = query(collection(db, "attendance"), where("date", ">=", startDate), where("date", "<=", endDate));
        const snap = await getDocs(q);

        const lq = query(collection(db, "leaves"), where("status", "==", "Approved"));
        const lSnap = await getDocs(lq);
        const userLeaves = {};
        lSnap.forEach(d => {
            const data = d.data();
            if (data.uid === uid || data.authUid === uid) {
                const [sY, sM, sD] = data.startDate.split('-');
                const [eY, eM, eD] = data.endDate.split('-');
                let curr = new Date(sY, sM - 1, sD);
                const endD = new Date(eY, eM - 1, eD);
                
                while(curr <= endD) {
                    const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
                    if (dStr >= startDate && dStr <= endDate) {
                        userLeaves[dStr] = data;
                    }
                    curr.setDate(curr.getDate() + 1);
                }
            }
        });

        const sSnap = await getDocs(query(collection(db, "schedules"), where("userId", "==", usersMap[uid].docId), where("date", ">=", startDate), where("date", "<=", endDate)));
        const userSchedules = {};
        sSnap.forEach(d => { userSchedules[d.data().date] = d.data(); });

        const dailyData = {};
        snap.forEach(doc => {
            const data = doc.data();
            if (data.uid === uid || docIdToAuthMap[data.uid] === uid) {
                if (!dailyData[data.date]) dailyData[data.date] = { in: null, out: null, breakOut: null, breakIn: null };
                
                if (data.session === 'Clock In' && (!dailyData[data.date].in || data.timestamp < dailyData[data.date].in.timestamp)) dailyData[data.date].in = data;
                if (data.session === 'Clock Out' && (!dailyData[data.date].out || data.timestamp > dailyData[data.date].out.timestamp)) dailyData[data.date].out = data;
                if (data.session === 'Break Out' && (!dailyData[data.date].breakOut || data.timestamp < dailyData[data.date].breakOut.timestamp)) dailyData[data.date].breakOut = data;
                if (data.session === 'Break In' && (!dailyData[data.date].breakIn || data.timestamp > dailyData[data.date].breakIn.timestamp)) dailyData[data.date].breakIn = data;
            }
        });

        const currentTodayStr = getLocalTodayStr();
        let totalMs = 0; 
        let html = '';
        
        const toDateObj = (t, dateStr) => {
            if(!t) return null;
            if(t.toDate) return t.toDate();
            if(typeof t === 'string' && t.includes(':')) return new Date(`${dateStr}T${t}:00`);
            return new Date(t);
        };

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${yyyy}-${mm}-${String(d).padStart(2, '0')}`;
            const dayRec = dailyData[dateStr];
            
            const hasSched = userSchedules[dateStr];
            
            let leaveObj = leavesMap[uid + "_" + dateStr] || userLeaves[dateStr];
            let leaveType = leaveObj ? leaveObj.type : null;
            let duration = leaveObj?.duration || 'Full Day';
            
            const isPH = !!holidaysMap[dateStr] && (!!hasSched || !!leaveType); 
            const phName = holidaysMap[dateStr] || '';
            if (isPH) leaveType = null; 

            let inStr = '-';
            let outStr = '-';
            let breakOutStr = '-';
            let breakInStr = '-';
            let hoursWorked = 0;
            let dailyWorkedMs = 0;

            if (dayRec) {
                if (dayRec.in) inStr = formatTime(dayRec.in.timestamp);
                if (dayRec.out) outStr = formatTime(dayRec.out.timestamp);
                if (dayRec.breakOut) breakOutStr = formatTime(dayRec.breakOut.timestamp);
                if (dayRec.breakIn) breakInStr = formatTime(dayRec.breakIn.timestamp);

                if (dayRec.in && dayRec.out) {
                    const inDate = dayRec.in.timestamp.toDate();
                    const outDate = dayRec.out.timestamp.toDate();
                    dailyWorkedMs = outDate - inDate;
                    
                    if (dayRec.breakOut && dayRec.breakIn) {
                        const bOutDate = dayRec.breakOut.timestamp.toDate();
                        const bInDate = dayRec.breakIn.timestamp.toDate();
                        const breakDurationMs = bInDate - bOutDate;
                        if (breakDurationMs > 0) dailyWorkedMs -= breakDurationMs;
                    }
                    
                    if (hasSched && hasSched.start && hasSched.end) {
                        const sStart = toDateObj(hasSched.start, dateStr);
                        const sEnd = toDateObj(hasSched.end, dateStr);
                        let schedDurMs = sEnd - sStart;
                        if (hasSched.breakMins) schedDurMs -= hasSched.breakMins * 60000;

                        if (schedDurMs > 0 && dailyWorkedMs > schedDurMs) {
                            dailyWorkedMs = schedDurMs;
                        }
                    }
                }
            }

            if (dailyWorkedMs > 0) {
                totalMs += dailyWorkedMs;
                hoursWorked = dailyWorkedMs / (1000 * 60 * 60);
            }

            let inDisplay = '';
            if (isPH && inStr === '-') {
                inDisplay = `<span class="badge bg-warning text-dark border border-warning-subtle" title="${phName}"><i data-lucide="star" class="size-3 me-1"></i> PUBLIC HOLIDAY</span>`;
            } else if (isPH && inStr !== '-') {
                inDisplay = `<span class="badge bg-success-subtle text-success border border-success-subtle">${inStr}</span> <span class="badge bg-warning text-dark ms-1" title="${phName}">PH (3x)</span>`;
            } else if (leaveType && inStr === '-') {
                let lText = leaveType.toUpperCase();
                if (duration !== 'Full Day') lText += ` (${duration.replace('Half Day ', '')})`;
                inDisplay = `<span class="badge bg-info text-dark border border-info-subtle">${lText}</span>`;
                
                if (duration !== 'Full Day' && hasSched) {
                    inDisplay += ` <span class="badge bg-danger-subtle text-danger border border-danger-subtle ms-1">Absent</span>`;
                }

            } else if (dayRec && dayRec.in) {
                inDisplay = `<span class="badge bg-success-subtle text-success border border-success-subtle">${inStr}</span>`;
            } else if (dateStr > currentTodayStr) {
                inDisplay = `<span class="text-muted small">-</span>`;
            } else if (hasSched) {
                inDisplay = `<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Absent</span>`;
            } else {
                inDisplay = `<span class="text-muted small">Off</span>`;
            }

            let outDisplay = '';
            if (dayRec && dayRec.out) {
                outDisplay = `<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">${outStr}</span>`;
            } else if (dayRec && dayRec.in && dateStr <= currentTodayStr) {
                outDisplay = `<span class="text-danger small">Missing</span>`;
            } else {
                outDisplay = `<span class="text-muted small">-</span>`;
            }

            html += `
                <tr>
                    <td class="ps-4 fw-medium text-dark">${dateStr}</td>
                    <td>${inDisplay}</td>
                    <td>${dayRec && dayRec.breakOut ? `<span class="badge bg-warning-subtle text-warning border border-warning-subtle">${breakOutStr}</span>` : `<span class="text-muted small">-</span>`}</td>
                    <td>${dayRec && dayRec.breakIn ? `<span class="badge bg-info-subtle text-info border border-info-subtle">${breakInStr}</span>` : `<span class="text-muted small">-</span>`}</td>
                    <td>${outDisplay}</td>
                    <td class="text-end pe-4 fw-bold ${hoursWorked > 0 ? 'text-dark' : 'text-muted'}">
                        ${hoursWorked > 0 ? hoursWorked.toFixed(2) + ' <span class="fw-normal text-muted small">h</span>' : '-'}
                    </td>
                </tr>
            `;
        }

        tbody.innerHTML = html;

        if (totalMs > 0) {
            const totalHours = (totalMs / (1000 * 60 * 60)).toFixed(2);
            document.getElementById('monthlyTotalHours').innerText = `${totalHours} h`;
            document.getElementById('monthlyReportFooter').style.display = 'table-footer-group'; 
        } else {
            document.getElementById('monthlyReportFooter').style.display = 'none';
        }

        if (window.lucide) window.lucide.createIcons();

    } catch (error) {
        console.error("Error generating report:", error);
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger py-5"><i data-lucide="alert-triangle" class="me-2"></i>Error loading report: ${error.message}</td></tr>`;
        if (window.lucide) window.lucide.createIcons();
    }
};

export function exportMonthlyReportToExcel() {
    const table = document.getElementById("monthlyReportTable");
    if (!table) return;

    const staffSelect = document.getElementById('reportStaffSelect');
    const monthSelect = document.getElementById('reportMonthInput');
    
    if (!staffSelect.value || !monthSelect.value) {
        showStatusAlert("Please generate a report first before exporting.", "warning");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; 

    const staffName = staffSelect.options[staffSelect.selectedIndex].text;
    const monthVal = monthSelect.value;

    csvContent += `Monthly Attendance Report\n`;
    csvContent += `Staff:,${staffName}\n`;
    csvContent += `Month:,${monthVal}\n\n`;

    const headers = Array.from(table.querySelectorAll("thead th")).map(th => `"${th.innerText.trim()}"`);
    csvContent += headers.join(",") + "\n";

    const tbody = document.getElementById('monthlyReportBody');
    const rows = Array.from(tbody.querySelectorAll("tr"));
    
    if (rows.length === 1 && rows[0].innerText.includes("Please select")) {
        showStatusAlert("No data to export.", "warning");
        return;
    }

    rows.forEach(row => {
        const rowData = Array.from(row.querySelectorAll("td")).map(td => {
            let text = td.innerText.replace(/(\r\n|\n|\r)/gm, " ").replace(/"/g, '""').trim();
            if(text.endsWith(" h")) text = text.slice(0, -2);
            return `"${text}"`;
        });
        csvContent += rowData.join(",") + "\n";
    });

    const footer = document.getElementById('monthlyReportFooter');
    if (footer && footer.style.display !== 'none') {
        const totalHours = document.getElementById('monthlyTotalHours').innerText.replace(" h", "");
        csvContent += `,,,,"Total Working Hours:","${totalHours}"\n`;
    }

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    const safeStaffName = staffName.replace(/\s+/g, '_');
    link.setAttribute("download", `Monthly_Report_${safeStaffName}_${monthVal}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ----------------------------------------------------
// 🟢 批量添加考勤记录 (Bulk Manual Action) - 适配 Select 模式
// ----------------------------------------------------

window.openBulkManualAction = () => {
    const currentDate = document.getElementById('dateFilter').value || getLocalTodayStr();
    document.getElementById('bulkManualDate').value = currentDate;
    document.getElementById('bulkManualTime').value = "";
    document.getElementById('bulkManualActionType').value = "";
    document.getElementById('bulkManualReason').value = "System recovery bulk entry";
    document.getElementById('bulkManualStaffSearch').value = ""; 

    // 🟢 实时根据所选日期加载当天的员工列表 (调用新增的动态加载函数)
    window.updateBulkManualStaffList();
    
    bulkManualActionModalInst.show();
    if (window.lucide) window.lucide.createIcons();
};

// 🟢 核心功能：当日期改变时，实时获取对应日期的排班和假单并过滤
window.updateBulkManualStaffList = async () => {
    const targetDate = document.getElementById('bulkManualDate').value;
    const staffSelect = document.getElementById('bulkManualStaffSelect');
    staffSelect.innerHTML = '<option disabled>Loading staff...</option>';
    
    if (!targetDate) return;

    try {
        // 1. 获取当天的 Schedule
        const sSnap = await getDocs(query(collection(db, "schedules"), where("date", "==", targetDate)));
        const dateSchedules = new Set();
        sSnap.forEach(d => {
            const uid = docIdToAuthMap[d.data().userId] || d.data().userId;
            dateSchedules.add(uid);
        });

        // 2. 获取当天的 Leaves (包括连跨几天的假单)
        const lSnap = await getDocs(query(collection(db, "leaves"), where("status", "==", "Approved"), where("startDate", "<=", targetDate)));
        const dateLeaves = new Set();
        lSnap.forEach(d => {
            const data = d.data();
            // 如果请假的结束日期 >= 目标日期，说明当天在请假期间内
            if (data.endDate >= targetDate) {
                const uid = data.authUid || docIdToAuthMap[data.uid] || data.uid;
                dateLeaves.add(uid);
            }
        });

        // 3. 构建选择列表
        staffSelect.innerHTML = '';
        const userList = Object.values(usersMap).sort((a, b) => a.name.localeCompare(b.name));
        let count = 0;

        userList.forEach(u => {
            if (u.status !== 'disabled' && u.role !== 'manager') {
                const uid = u.authUid || u.docId;
                
                // 🟢 核心判断：只有当天有排班，且没有请假的员工才显示
                if (dateSchedules.has(uid) && !dateLeaves.has(uid)) {
                    const opt = document.createElement('option');
                    opt.value = uid;
                    opt.text = u.name;
                    opt.dataset.name = u.name;
                    opt.dataset.email = u.email || '';
                    staffSelect.appendChild(opt);
                    count++;
                }
            }
        });

        if (count === 0) {
            staffSelect.innerHTML = `<option disabled>No scheduled staff found (or all on leave).</option>`;
        }

        // 如果用户在搜素框里有内容，重新过滤一次
        if(typeof window.filterBulkManualStaff === 'function') {
            window.filterBulkManualStaff();
        }

    } catch (error) {
        console.error("Error loading target date staff:", error);
        staffSelect.innerHTML = '<option disabled>Error loading staff.</option>';
    }
};

window.submitBulkManualAction = async () => {
    const dateStr = document.getElementById('bulkManualDate').value;
    const timeStr = document.getElementById('bulkManualTime').value;
    const actionType = document.getElementById('bulkManualActionType').value;
    const remarks = document.getElementById('bulkManualReason').value || "Admin Bulk Entry";

    if (!dateStr || !timeStr || !actionType) {
        alert("Please select Date, Time, and Action Type.");
        return;
    }

    const staffSelect = document.getElementById('bulkManualStaffSelect');
    const selectedOptions = Array.from(staffSelect.selectedOptions);

    if (selectedOptions.length === 0) {
        alert("Please select at least one staff member.");
        return;
    }

    if (!confirm(`Are you sure you want to bulk add [${actionType}] at [${timeStr}] for ${selectedOptions.length} staff members?`)) {
        return;
    }

    showLoading();
    try {
        const batch = writeBatch(db);
        const preciseDate = new Date(`${dateStr}T${timeStr}:00`);
        let addedCount = 0;

        selectedOptions.forEach(opt => {
            const uid = opt.value;
            const name = opt.dataset.name;
            const email = opt.dataset.email;

            const newRef = doc(collection(db, "attendance"));
            batch.set(newRef, {
                uid: uid,
                name: name,
                email: email,
                date: dateStr,
                session: actionType,
                timestamp: Timestamp.fromDate(preciseDate),
                verificationStatus: "Verified",
                address: "Admin Bulk Entry",
                remarks: remarks
            });
            addedCount++;
        });

        await batch.commit();

        await logAdminAction(db, auth.currentUser, "BULK_MANUAL_ADD_ATTENDANCE", "MULTIPLE", null, {
            date: dateStr, 
            time: timeStr, 
            action: actionType, 
            staffCount: addedCount
        });

        bulkManualActionModalInst.hide();
        hideLoading();
        showStatusAlert('statusMessage', `Successfully added ${actionType} record for ${addedCount} staff members.`, true);
        
        window.loadData();

    } catch (e) {
        console.error(e);
        hideLoading();
        showStatusAlert('statusMessage', `Bulk add failed: ${e.message}`, false);
    }
};