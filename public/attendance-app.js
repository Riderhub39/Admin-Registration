// attendance-app.js

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
let docIdToAuthMap = {}; 
let attendanceData = []; 
let currentMode = 'day'; 

let photoModal, manualActionModal, editRecordModal, bulkVerifyModalInst; // 🟢 新增 bulkVerifyModalInst
let unsubscribeAttendance = null; 
let unverifiedRecordsCache = []; 

// 获取本地当天的标准化日期字符串 YYYY-MM-DD
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
        bulkVerifyModalInst = new bootstrap.Modal(document.getElementById('bulkVerifyModal')); // 🟢 初始化批量验证弹窗
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
        if (filterEl) {
            filterEl.value = urlFilter;
        }
    }

    if (urlTab) {
        const tabBtn = document.getElementById(`tab-${urlTab}`);
        if (tabBtn && typeof bootstrap !== 'undefined') {
            const tab = new bootstrap.Tab(tabBtn);
            tab.show();
        }
    }

    await fetchUsers();
    window.loadData();
    listenToCorrections();
}

async function fetchUsers() {
    const snap = await getDocs(query(collection(db, "users"), where("role", "==", "staff")));
    snap.forEach(docSnap => {
        const d = docSnap.data();
        if (d.authUid) docIdToAuthMap[docSnap.id] = d.authUid;
        const key = d.authUid || docSnap.id;
        usersMap[key] = {
            name: d.personal?.name || d.name || "Unknown Staff",
            photo: d.faceIdPhoto || null,
            email: d.personal?.email,
            status: d.status || 'active',
            docId: docSnap.id,
            authUid: d.authUid,
            empCode: d.empCode // 确保用户文档中有 empCode 字段，如果没有下方有 fallback 处理
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
            const eUid = data.authUid || docIdToAuthMap[d.uid] || d.uid;
            let curr = new Date(data.startDate);
            while(curr <= new Date(data.endDate)) {
                const dStr = curr.toISOString().split('T')[0];
                if(dStr >= startDate && dStr <= endDate) leavesMap[eUid + "_" + dStr] = data.type;
                curr.setDate(curr.getDate() + 1);
            }
        });

        if (unsubscribeAttendance) {
            unsubscribeAttendance();
        }

        const attQuery = query(collection(db, "attendance"), where("date", ">=", startDate), where("date", "<=", endDate));
        unsubscribeAttendance = onSnapshot(attQuery, (attSnap) => {
            processAndRenderAttendance(attSnap, startDate, endDate);
        }, (error) => {
            console.error("Error listening to attendance:", error);
        });

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

    const dayFilter = document.getElementById('dayStatusFilter') ? document.getElementById('dayStatusFilter').value : 'all';
    let recordsToRender = [];

    if(currentMode === 'day') {
         Object.keys(usersMap).forEach(uid => {
             if(usersMap[uid].status === 'disabled') return;

             const dayRecords = grouped[uid] || [];
             const hasIn = dayRecords.some(r => r.session === 'Clock In');
             const hasOut = dayRecords.some(r => r.session === 'Clock Out');
             const hasUnverified = dayRecords.some(r => r.verificationStatus !== 'Verified');
             
             const targetDate = startDate; 
             const isMissingOut = hasIn && !hasOut && (targetDate < currentTodayStr);

             if (isMissingOut) {
                 missingOutData.push(usersMap[uid].name);
             }

             let showUser = false;
             if (dayFilter === 'all') showUser = true;
             else if (dayFilter === 'clockedIn' && hasIn) showUser = true; 
             else if (dayFilter === 'unverified' && hasUnverified) showUser = true;
             else if (dayFilter === 'missingOut' && isMissingOut) showUser = true;

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
            if(renderDayUserCard(uid, grouped[uid] || [], listContainer, normalizeDate(startDate), currentTodayStr)) count++; 
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
        const statusFilter = document.getElementById('monthStatusFilter').value; 
        sortedUids.forEach(uid => { 
            if(usersMap[uid].status !== 'disabled' && renderMonthUserCard(uid, grouped[uid] || [], listContainer, statusFilter, currentTodayStr)) count++; 
        });
        
        const bulkBtn = document.getElementById('bulkVerifyBtn');
        if(bulkBtn) bulkBtn.classList.add('d-none'); 
    }
    
    if(count === 0 && recordsToRender.length === 0) document.getElementById('emptyState').classList.remove('d-none');
    else document.getElementById('emptyState').classList.add('d-none');
    
    hideLoading();
    document.getElementById('mainContainer').classList.remove('d-none');
    
    lucide.createIcons();
}

function renderDayUserCard(uid, records, container, targetDate, currentTodayStr) {
    const user = usersMap[uid];
    const sched = schedulesMap[uid + "_" + targetDate];
    const leave = leavesMap[uid + "_" + targetDate];
    
    if (!sched && records.length === 0 && !leave) return false;

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

    const isAbsent = (targetDate <= currentTodayStr) && inT === "--:--" && sched && !leave;
    const isMissingOut = inT !== "--:--" && outT === "--:--" && targetDate < currentTodayStr;
    const isClockedInToday = inT !== "--:--" && outT === "--:--" && targetDate === currentTodayStr;

    const card = document.createElement('div');
    card.className = `user-card user-card-container ${isAbsent ? 'row-absent' : (leave ? 'row-leave' : '')}`;
    card.setAttribute('data-name', user.name);
    
    let statusColor = isAbsent ? "bg-danger" : 
                      (leave ? "bg-info" : 
                      (isMissingOut ? "bg-danger" : 
                      (isClockedInToday ? "bg-warning" : 
                      (pending > 0 ? "bg-warning" : 
                      (inT !== "--:--" ? "bg-success" : "bg-secondary")))));

    const statusLabel = isAbsent ? `<span class="badge bg-danger">ABSENT</span>` : 
                        (leave && inT === '--:--' ? `<span class="badge bg-info">ON LEAVE</span>` : 
                        (isMissingOut ? `<span class="badge bg-danger">MISSING OUT</span>` : 
                        (isClockedInToday ? `<span class="badge bg-warning text-dark">CLOCKED IN</span>` : "")));

    card.innerHTML = `
        <div class="card-header-custom collapsed" data-bs-toggle="collapse" data-bs-target="#collapse-${uid}">
            <div class="row align-items-center">
                <div class="col-md-4 d-flex align-items-center gap-3 border-end border-light">
                    <div class="position-relative">
                        ${user.photo ? `<img src="${user.photo}" class="staff-avatar">` : `<div class="staff-avatar">${user.name.charAt(0)}</div>`}
                        <span class="position-absolute top-0 start-100 translate-middle p-1 border border-light rounded-circle ${statusColor}"></span>
                    </div>
                    <div><h6 class="fw-bold text-dark m-0 text-truncate" style="max-width:150px">${user.name}</h6><small class="text-muted">Shift: ${sched?formatTime(sched.start)+'-'+formatTime(sched.end):'Off'}</small></div>
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
    let rowsHtml = "";

    for(let d=1; d<=days; d++) {
        const dateStr = `${y}-${m}-${d.toString().padStart(2,'0')}`;
        const sched = schedulesMap[uid + "_" + dateStr];
        const leave = leavesMap[uid + "_" + dateStr];
        const dayRecords = allRecords.filter(r => r.date === dateStr && r.verificationStatus === 'Verified');

        let inT = null;
        let hasOut = false;
        dayRecords.forEach(r => { 
            if(r.session === 'Clock In') inT = formatTime(r.timestamp); 
            if(r.session === 'Clock Out') hasOut = true; 
        });
        if(inT) present++;

        if (dayRecords.length > 0 || sched || leave) {
            let statusHtml = '';
            if (leave && !inT) statusHtml = '<span class="text-info fw-bold">ON LEAVE</span>';
            else if (inT && !hasOut && dateStr < currentTodayStr) statusHtml = '<span class="text-danger fw-bold">MISSING OUT</span>';
            else if (inT) statusHtml = '<b>Verified Present</b>';
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
    card.innerHTML = `<div class="card-header-custom collapsed" data-bs-toggle="collapse" data-bs-target="#collapse-month-${uid}"><div class="row align-items-center"><div class="col-4 d-flex align-items-center gap-3">${user.photo?`<img src="${user.photo}" class="staff-avatar">`:`<div class="staff-avatar">${user.name.charAt(0)}</div>`}<div><h6 class="fw-bold m-0">${user.name}</h6></div></div><div class="col-7 text-center"><div class="stat-label">Days Present</div><div class="stat-value">${present} / ${days}</div></div><div class="col-1 text-end"><i data-lucide="chevron-down" class="text-muted chevron-icon"></i></div></div></div><div id="collapse-month-${uid}" class="collapse"><ul class="list-group list-group-flush">${rowsHtml}</ul></div>`;
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
    let active=0, leave=0, absent=0;
    const aList = [];
    Object.keys(usersMap).forEach(uid => {
        if(usersMap[uid].status === 'disabled') return;
        active++;
        if(leavesMap[uid+"_"+target]) leave++;
        else if(schedulesMap[uid+"_"+target] && !pUids.has(uid)) { absent++; aList.push(usersMap[uid].name); }
    });
    
    document.getElementById('statTotalStaff').innerText = active;
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

// 🟢 优化4: 打开 Bulk Verify 弹窗并渲染表格数据
window.bulkVerify = () => {
    if (unverifiedRecordsCache.length === 0) {
        alert("No unverified records available.");
        return;
    }

    // 将未验证的数据按照员工分组归类
    const groupedData = {};
    unverifiedRecordsCache.forEach(record => {
        if (!groupedData[record.uid]) {
            const user = usersMap[record.uid] || {};
            groupedData[record.uid] = {
                name: user.name || "Unknown Staff",
                empCode: user.empCode || `EMP-${record.uid.substring(0, 5).toUpperCase()}`, // Fallback 处理
                records: []
            };
        }
        groupedData[record.uid].records.push(record);
    });

    // 填充弹窗中的表格
    const tbody = document.getElementById('bulkVerifyListBody');
    tbody.innerHTML = '';

    Object.values(groupedData).forEach(emp => {
        let cin = '--:--', cout = '--:--', bout = '--:--', bin = '--:--';
        
        // 匹配各类打卡的时间
        emp.records.forEach(r => {
            const timeStr = r.timestamp ? formatTime(r.timestamp) : "--:--";
            if (r.session === 'Clock In') cin = timeStr;
            else if (r.session === 'Clock Out') cout = timeStr;
            else if (r.session === 'Break Out') bout = timeStr;
            else if (r.session === 'Break In') bin = timeStr;
        });

        // 拼接表格行
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

// 🟢 优化5: 确认提交批量 Verify 的后台写入
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
        // 注意：由于 onSnapshot 实时监听，Firestore 写入成功后前端会自动触发渲染，不需要手动刷新。
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
            const leaveData = { uid: userObj.docId, authUid: userObj.authUid, empName: userObj.name, type: 'Absent', startDate: dateStr, endDate: dateStr, days: 1, status: 'Approved', reviewedAt: serverTimestamp(), isPayrollDeductible: true, reason: document.getElementById('manualReason').value || "Admin Manual Absent" };
            batch.set(leaveRef, leaveData);
            
            await logAdminAction(db, auth.currentUser, "MANUAL_ATTENDANCE_ABSENT", userObj.docId, oldDataSnapshot, leaveData);
            await batch.commit();

        } else if (type.includes('Leave')) {
            await batch.commit(); 
            await runTransaction(db, async (tx) => {
                const uRef = doc(db, "users", userObj.docId);
                const uDoc = await tx.get(uRef);
                const oldBal = uDoc.data().leave_balance?.annual || 0;
                if(type === 'Annual Leave') tx.update(uRef, { "leave_balance.annual": oldBal - 1 });
                
                const leaveData = { uid: userObj.docId, authUid: userObj.authUid, empName: userObj.name, type, startDate: dateStr, endDate: dateStr, days: 1, status: 'Approved', reviewedAt: serverTimestamp(), isPayrollDeductible: type === 'Unpaid Leave', reason: document.getElementById('manualReason').value || "Admin Manual Leave" };
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
                tbody.innerHTML += `<tr><td class="ps-4"><b>${d.empName || d.email?.split('@')[0]}</b><br><small>${d.targetDate}</small></td><td>${d.originalIn}<br>${d.originalOut}</td><td class="text-primary fw-bold">${d.requestedIn}<br>${d.requestedOut}</td><td><small>${d.remarks||'-'}</small></td><td class="text-end pe-4"><button class="btn btn-sm btn-success me-1" onclick="window.handleCorrection('${docSnap.id}', '${d.attendanceId}', '${d.requestedIn}', '${d.requestedOut}', 'approve')">✔</button><button class="btn btn-sm btn-danger" onclick="window.handleCorrection('${docSnap.id}', null, null, null, 'reject')">✖</button></td></tr>`;
            });
        }
    });
}

window.handleCorrection = async (correctionId, attId, newIn, newOut, decision) => {
    if(!confirm(`Confirm ${decision} this correction request?`)) return;
    
    showLoading();
    try {
        if (decision === 'approve') {
            await updateDoc(doc(db, "attendance_corrections", correctionId), { status: "Approved", reviewedAt: serverTimestamp(), reviewer: auth.currentUser.email });
            if (attId) {
                await updateDoc(doc(db, "attendance", attId), { verificationStatus: "Archived" });
            }
        } else {
            await updateDoc(doc(db, "attendance_corrections", correctionId), { status: "Rejected", reviewedAt: serverTimestamp(), reviewer: auth.currentUser.email });
        }
        
        await logAdminAction(db, auth.currentUser, `CORRECTION_${decision.toUpperCase()}`, attId || "N/A", null, { correctionId, newIn, newOut });
        
        hideLoading();
        showStatusAlert('statusMessage', `Correction ${decision}d.`, true);
    } catch (e) {
        hideLoading();
        showStatusAlert('statusMessage', `Error: ${e.message}`, false);
    }
}

window.exportData = () => { showStatusAlert('statusMessage', "Export feature enabled. CSV will be generated based on current filter.", true); };

window.viewPhoto = (url) => {
    document.getElementById('modalImg').src = url;
    photoModal.show();
};