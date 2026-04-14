// leave-approval-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, onSnapshot, doc, runTransaction, updateDoc, serverTimestamp, limit, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

import { firebaseConfig } from "./firebase-config.js";
import { normalizeDate, logAdminAction, formatDate, formatDateTime, showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app); 

let fullHistoryList = [];
let attachmentModal, rejectModal, editStatusModal, addLeaveModalInst;
let usersMap = {}; 
let holidaysMap = {}; 

export async function initLeaveApprovalApp() {
    document.getElementById('loadingText').innerText = "Loading Requests...";
    document.getElementById('todayDate').innerText = new Date().toLocaleDateString('en-GB');
    
    if (typeof bootstrap !== 'undefined') {
        attachmentModal = new bootstrap.Modal(document.getElementById('attachmentModal'));
        rejectModal = new bootstrap.Modal(document.getElementById('rejectModal'));
        editStatusModal = new bootstrap.Modal(document.getElementById('editStatusModal'));
        addLeaveModalInst = new bootstrap.Modal(document.getElementById('addLeaveModal'));
    }

    await fetchHolidays(); 
    await fetchUsers(); 
    listenToPendingLeaves();
    listenToLeaveHistory();
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
    const staffSelect = document.getElementById('addLeaveStaff');
    if(staffSelect) staffSelect.innerHTML = '<option value="">-- Select Employee --</option>';
    
    let users = [];
    snap.forEach(docSnap => {
        const d = docSnap.data();
        if (d.status !== 'disabled' && d.role !== 'manager') {
            users.push({
                id: docSnap.id,
                authUid: d.authUid || "",
                name: d.personal?.name || d.name || "Unknown Staff",
                email: d.personal?.email || ""
            });
        }
    });
    
    users.sort((a,b) => a.name.localeCompare(b.name)).forEach(u => {
        usersMap[u.id] = u;
        if(staffSelect) {
            staffSelect.innerHTML += `<option value="${u.id}">${u.name}</option>`;
        }
    });
}

async function getValidPhCount(uid, authUid, startDate, endDate) {
    const searchIds = [uid];
    if (authUid) searchIds.push(authUid);
    
    const schedSnap = await getDocs(query(collection(db, "schedules"), where("userId", "in", searchIds), where("date", ">=", startDate), where("date", "<=", endDate)));
    const scheds = {};
    schedSnap.forEach(d => scheds[d.data().date] = true);

    let validPhCount = 0;
    const [sY, sM, sD] = startDate.split('-');
    const [eY, eM, eD] = endDate.split('-');
    let curr = new Date(sY, sM - 1, sD);
    const endD = new Date(eY, eM - 1, eD);

    while(curr <= endD) {
        const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
        if (holidaysMap[dStr] && scheds[dStr]) {
            validPhCount++;
        }
        curr.setDate(curr.getDate() + 1);
    }
    return validPhCount;
}

function listenToPendingLeaves() {
    const q = query(collection(db, "leaves"), where("status", "==", "Pending"));
    
    onSnapshot(q, (snapshot) => {
        const listContainer = document.getElementById('pendingList');
        const badge = document.getElementById('pendingBadge');
        
        listContainer.innerHTML = '';
        document.getElementById('pendingLoading').classList.add('d-none');
        
        if (snapshot.empty) {
            document.getElementById('noPendingMsg').classList.remove('d-none');
            badge.classList.add('d-none');
            badge.innerText = "0";
            return;
        }

        document.getElementById('noPendingMsg').classList.add('d-none');
        badge.classList.remove('d-none');
        badge.innerText = snapshot.size;

        let docsData = [];
        snapshot.forEach(doc => docsData.push({ id: doc.id, ...doc.data() }));
        docsData.sort((a, b) => (b.appliedAt?.seconds || 0) - (a.appliedAt?.seconds || 0));

        docsData.forEach(data => {
            const appliedStr = data.appliedAt ? formatDateTime(data.appliedAt.toDate()) : 'Unknown time';
            
            let typeColor = "text-primary bg-primary";
            if (data.type === 'Medical Leave') typeColor = "text-danger bg-danger";
            if (data.type === 'Unpaid Leave') typeColor = "text-warning text-dark bg-warning";

            // 🟢 新增：如果含有半天假标识，显示 (AM) 或 (PM)
            const durationDisplay = (data.duration && data.duration !== 'Full Day') 
                ? ` <span class="badge bg-secondary ms-1">${data.duration.replace('Half Day ', '')}</span>` 
                : '';

            listContainer.innerHTML += `
                <div class="card border-0 shadow-sm rounded-4 mb-3">
                    <div class="card-body p-4">
                        <div class="row align-items-center">
                            <div class="col-md-3 border-end">
                                <h6 class="fw-bold text-dark mb-1">${data.empName || 'Unknown Staff'}</h6>
                                <div class="text-muted small">${data.email || ''}</div>
                                <div class="mt-2 text-muted small"><i data-lucide="clock" class="size-3 me-1"></i>Applied: ${appliedStr}</div>
                            </div>
                            <div class="col-md-6 px-4">
                                <div class="d-flex align-items-center mb-2">
                                    <span class="badge ${typeColor} bg-opacity-10 ${typeColor.split(' ')[0]} border border-opacity-25 me-2">${data.type}</span>
                                    <span class="fw-bold text-dark">${data.days} Day(s) ${durationDisplay}</span>
                                </div>
                                <div class="fw-medium text-dark mb-2">
                                    <i data-lucide="calendar-range" class="size-4 text-muted me-2"></i>
                                    ${formatDate(data.startDate)} <i data-lucide="arrow-right" class="size-3 mx-1 text-muted"></i> ${formatDate(data.endDate)}
                                </div>
                                <div class="text-muted small bg-light p-2 rounded border">
                                    <b>Reason:</b> ${data.reason || 'No reason provided.'}
                                </div>
                            </div>
                            <div class="col-md-3 text-end">
                                <div class="d-flex flex-column gap-2">
                                    <button class="btn btn-success fw-bold shadow-sm" onclick="window.approveLeave('${data.id}', '${data.uid}', ${data.days}, '${data.type}', '${data.startDate}', '${data.endDate}')">
                                        <i data-lucide="check" class="size-4 me-1"></i> Approve
                                    </button>
                                    <button class="btn btn-outline-danger fw-bold" onclick="window.openRejectModal('${data.id}', '${data.uid}')">
                                        <i data-lucide="x" class="size-4 me-1"></i> Reject
                                    </button>
                                    ${data.attachmentUrl 
                                        ? `<button class="btn btn-sm btn-light text-primary border" onclick="window.viewAttachment('${data.attachmentUrl}', '${data.fileType || ''}')"><i data-lucide="paperclip" class="size-4 me-1"></i> View Proof</button>`
                                        : `<span class="text-muted small py-1"><i data-lucide="file-minus" class="size-3 me-1"></i>No Proof</span>`
                                    }
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });
        
        document.getElementById('mainContainer').classList.remove('d-none');
        hideLoading();
        if (window.lucide) window.lucide.createIcons();
    }, (error) => {
        console.error(error);
        hideLoading();
        showStatusAlert('statusMessage', 'Error loading pending requests.', false);
    });
}

function listenToLeaveHistory() {
    const q = query(collection(db, "leaves"), where("status", "in", ["Approved", "Rejected"]));
    
    onSnapshot(q, (snapshot) => {
        fullHistoryList = [];
        snapshot.forEach(doc => fullHistoryList.push({ id: doc.id, ...doc.data() }));
        fullHistoryList.sort((a, b) => (b.reviewedAt?.seconds || 0) - (a.reviewedAt?.seconds || 0));
        
        window.filterHistory();
    });
}

window.filterHistory = function() {
    const filter = document.getElementById('historyFilter').value;
    const tbody = document.getElementById('historyListBody');
    tbody.innerHTML = '';

    const filtered = filter === 'all' ? fullHistoryList : fullHistoryList.filter(d => d.type === filter);

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">No records found.</td></tr>';
        return;
    }

    filtered.forEach(data => {
        const reviewStr = data.reviewedAt ? formatDate(data.reviewedAt.toDate()) : '-';
        const isApprove = data.status === 'Approved';
        
        let typeClass = "text-primary";
        if (data.type === 'Medical Leave') typeClass = "text-danger";
        if (data.type === 'Unpaid Leave') typeClass = "text-warning text-dark";

        const attachmentBtn = data.attachmentUrl 
            ? `<button class="btn btn-link btn-sm p-0 text-info text-decoration-none ms-3" onclick="window.viewAttachment('${data.attachmentUrl}', '${data.fileType || ''}')"><i data-lucide="paperclip" class="size-3 me-1"></i>Proof</button>`
            : '';

        const deductInfo = (data.deductibleDays !== undefined && data.deductibleDays < data.days) 
            ? `<br><small class="text-warning">(-${data.deductibleDays} deducted)</small>` 
            : '';

        // 🟢 新增：如果含有半天假标识，显示 (AM) 或 (PM)
        const durationDisplay = (data.duration && data.duration !== 'Full Day') 
            ? ` <small class="text-muted">(${data.duration.replace('Half Day ', '')})</small>` 
            : '';

        tbody.innerHTML += `
            <tr>
                <td class="ps-4">
                    <div class="fw-bold text-dark">${data.empName || 'Unknown'}</div>
                    <div class="small text-muted" style="font-size: 0.75rem;">${data.uid}</div>
                </td>
                <td class="fw-bold ${typeClass}">${data.type}${durationDisplay}</td>
                <td>
                    <div class="small text-dark">${formatDate(data.startDate)}</div>
                    <div class="small text-muted">to ${formatDate(data.endDate)}</div>
                </td>
                <td class="fw-bold">${data.days} ${deductInfo}</td>
                <td>
                    <span class="badge ${isApprove ? 'bg-success bg-opacity-10 text-success border border-success-subtle' : 'bg-danger bg-opacity-10 text-danger border border-danger-subtle'}">
                        ${data.status}
                    </span>
                </td>
                <td class="text-end pe-4">
                    <div class="small text-dark mb-1">${reviewStr}</div>
                    <div class="d-flex justify-content-end align-items-center">
                        <button class="btn btn-link btn-sm p-0 text-decoration-none" onclick="window.openEditStatusModal('${data.id}', '${data.uid}', '${data.status}', '${data.reason || ''}')">Edit</button>
                        ${attachmentBtn} 
                    </div>
                </td>
            </tr>
        `;
    });

    if (window.lucide) window.lucide.createIcons();
}

window.approveLeave = async function(leaveId, targetUid, days, type, startDate, endDate) {
    if (!confirm(`Approve ${days} day(s) of ${type}?`)) return;

    showLoading();
    document.getElementById('loadingText').innerText = "Processing Approval...";
    
    try {
        const phOverlap = await getValidPhCount(targetUid, usersMap[targetUid]?.authUid, startDate, endDate);
        const actualDeductibleDays = Math.max(0, days - phOverlap);

        await runTransaction(db, async (transaction) => {
            const leaveRef = doc(db, "leaves", leaveId);
            const userRef = doc(db, "users", targetUid);
            const userDoc = await transaction.get(userRef);

            const isAnnual = (type === 'Annual Leave' || type === '年假' || type === 'Cuti Tahunan');
            let currentBalance = 0;

            if (isAnnual && actualDeductibleDays > 0) {
                currentBalance = userDoc.data().leave_balance?.annual || 0;
                if (currentBalance < actualDeductibleDays) throw new Error(`Insufficient Balance! Current: ${currentBalance}, Required to deduct: ${actualDeductibleDays}`);
                transaction.update(userRef, { "leave_balance.annual": currentBalance - actualDeductibleDays });
            } 
            
            transaction.update(leaveRef, { 
                status: 'Approved', 
                reviewedAt: serverTimestamp(), 
                reviewer: auth.currentUser.email, 
                isPayrollDeductible: (type === 'Unpaid Leave'), 
                deductibleDays: actualDeductibleDays, 
                phOverlap: phOverlap 
            });

            logAdminAction(db, auth.currentUser, "APPROVE_LEAVE", targetUid, 
                { leaveId: leaveId, oldBalance: currentBalance }, 
                { daysRequested: days, daysDeducted: actualDeductibleDays, phOverlap: phOverlap, type: type }
            );
        });
        hideLoading();
        let msg = 'Leave approved successfully.';
        if (phOverlap > 0) msg += `\n(Overlapped with ${phOverlap} Public Holiday(s), balance deduction reduced.)`;
        showStatusAlert('statusMessage', msg, true);
    } catch (e) { 
        console.error(e); 
        hideLoading();
        showStatusAlert('statusMessage', `Failed: ${e.message}`, false); 
    }
}

// 🟢 新增：检查是否为单日，如果是单日则允许选择半天假
window.checkSingleDay = function() {
    const startStr = document.getElementById('addLeaveStart').value;
    const endStr = document.getElementById('addLeaveEnd').value;
    const durationGroup = document.getElementById('addLeaveDurationGroup');
    const durationSelect = document.getElementById('addLeaveDuration');

    if (startStr && endStr && startStr === endStr) {
        durationGroup.classList.remove('d-none');
    } else {
        durationGroup.classList.add('d-none');
        durationSelect.value = 'Full Day';
    }
};

window.openAddLeaveModal = () => {
    document.getElementById('addLeaveStaff').value = "";
    document.getElementById('addLeaveType').value = "Annual Leave";
    document.getElementById('addLeaveStart').value = "";
    document.getElementById('addLeaveEnd').value = "";
    document.getElementById('addLeaveDuration').value = "Full Day"; // 🟢 重置时长
    document.getElementById('addLeaveReason').value = "";
    document.getElementById('addLeaveAttachment').value = ""; 
    
    window.checkSingleDay(); // 初始化显示状态
    addLeaveModalInst.show();
};

window.submitAddLeave = async () => {
    const staffId = document.getElementById('addLeaveStaff').value;
    const type = document.getElementById('addLeaveType').value;
    const startStr = document.getElementById('addLeaveStart').value;
    const endStr = document.getElementById('addLeaveEnd').value;
    const duration = document.getElementById('addLeaveDuration').value; // 🟢 获取请假时长
    const reason = document.getElementById('addLeaveReason').value || "Added by Admin";
    
    const fileInput = document.getElementById('addLeaveAttachment');
    const file = fileInput.files[0];

    if (!staffId || !startStr || !endStr) {
        alert("Please fill in all required fields.");
        return;
    }

    const sDate = new Date(startStr);
    const eDate = new Date(endStr);
    if (eDate < sDate) {
        alert("End date cannot be earlier than start date.");
        return;
    }

    // 🟢 调整：如果选了半天假，并且是同一天，天数算作 0.5
    let days = Math.round((eDate - sDate) / (1000 * 60 * 60 * 24)) + 1;
    if (startStr === endStr && duration !== 'Full Day') {
        days = 0.5;
    }

    const user = usersMap[staffId];
    if (!confirm(`Add ${days} day(s) of ${type} for ${user.name}?`)) return;

    showLoading();

    try {
        let attachmentUrl = null;
        let fileType = null;

        if (file) {
            document.getElementById('loadingText').innerText = "Uploading Attachment...";
            const ext = file.name.split('.').pop().toLowerCase();
            const targetUid = user.authUid || staffId;
            const fileName = `${Date.now()}_${targetUid}.${ext}`;
            const fileRef = storageRef(storage, `leave_attachments/${targetUid}/${fileName}`);
            
            await uploadBytes(fileRef, file);
            attachmentUrl = await getDownloadURL(fileRef);
            fileType = ext;
        }

        document.getElementById('loadingText').innerText = "Saving Record...";

        const phOverlap = await getValidPhCount(staffId, user.authUid, startStr, endStr);
        const actualDeductibleDays = Math.max(0, days - phOverlap);

        await runTransaction(db, async (transaction) => {
            const userRef = doc(db, "users", staffId);
            const userDoc = await transaction.get(userRef);
            
            let oldBalance = 0;
            if (type === 'Annual Leave' && actualDeductibleDays > 0) {
                oldBalance = userDoc.data().leave_balance?.annual || 0;
                if (oldBalance < actualDeductibleDays) {
                    throw new Error(`Insufficient Annual Leave Balance! Current: ${oldBalance}, Required to deduct: ${actualDeductibleDays}`);
                }
                transaction.update(userRef, { "leave_balance.annual": oldBalance - actualDeductibleDays });
            }

            const newLeaveRef = doc(collection(db, "leaves"));
            const leaveData = {
                uid: staffId,
                authUid: user.authUid,
                empName: user.name,
                email: user.email,
                type: type,
                startDate: startStr,
                endDate: endStr,
                days: days, // 🟢 存入计算后的 0.5 或整数
                duration: duration, // 🟢 存入具体的时段 (Full Day, Half Day AM, Half Day PM)
                deductibleDays: actualDeductibleDays, 
                phOverlap: phOverlap, 
                reason: reason,
                status: 'Approved',
                appliedAt: serverTimestamp(),
                reviewedAt: serverTimestamp(),
                reviewer: auth.currentUser.email,
                isPayrollDeductible: (type === 'Unpaid Leave')
            };

            if (attachmentUrl) {
                leaveData.attachmentUrl = attachmentUrl;
                leaveData.fileType = fileType;
            }
            
            transaction.set(newLeaveRef, leaveData);

            logAdminAction(db, auth.currentUser, "MANUAL_ADD_LEAVE", staffId, 
                { oldBalance: oldBalance }, 
                leaveData
            );
        });

        addLeaveModalInst.hide();
        hideLoading();
        let msg = 'Leave manually added and approved successfully.';
        if (phOverlap > 0) msg += `\n(Overlapped with ${phOverlap} Public Holiday(s), balance deduction reduced.)`;
        showStatusAlert('statusMessage', msg, true);
    } catch (e) {
        console.error(e);
        hideLoading();
        showStatusAlert('statusMessage', `Failed: ${e.message}`, false);
    }
};

window.viewAttachment = function(url, fileType = '') {
    const img = document.getElementById('attachmentImg');
    const msg = document.getElementById('noAttachmentMsg');
    const modalBody = img.parentElement;

    const oldIframe = document.getElementById('attachmentPdf');
    if (oldIframe) oldIframe.remove();
    const oldBtn = document.getElementById('attachmentPdfBtn');
    if (oldBtn) oldBtn.remove();

    if(url) { 
        msg.classList.add('d-none'); 
        const isPdf = fileType.toLowerCase() === 'pdf' || url.toLowerCase().includes('.pdf?alt=media');

        if (isPdf) {
            img.classList.add('d-none');
            const iframe = document.createElement('iframe');
            iframe.id = 'attachmentPdf';
            iframe.src = url;
            iframe.style.width = '100%';
            iframe.style.height = '60vh';
            iframe.style.border = 'none';
            modalBody.appendChild(iframe);

            const btn = document.createElement('a');
            btn.id = 'attachmentPdfBtn';
            btn.href = url;
            btn.target = '_blank';
            btn.className = 'btn btn-primary mt-3 mb-2 fw-bold d-inline-block px-4';
            btn.innerHTML = '<i data-lucide="external-link" class="size-4 me-2"></i>Open PDF in New Tab';
            modalBody.appendChild(btn);
            
            if (window.lucide) window.lucide.createIcons();
        } else {
            img.src = url; 
            img.classList.remove('d-none'); 
        }
    } else { 
        img.classList.add('d-none'); 
        msg.classList.remove('d-none'); 
    }
    attachmentModal.show();
}

window.openRejectModal = function(leaveId, targetUid) {
    document.getElementById('rejectLeaveId').value = leaveId;
    document.getElementById('rejectAuthUid').value = targetUid;
    document.getElementById('rejectReasonInput').value = '';
    rejectModal.show();
}

window.confirmReject = async function() {
    const leaveId = document.getElementById('rejectLeaveId').value;
    const targetUid = document.getElementById('rejectAuthUid').value;
    const reason = document.getElementById('rejectReasonInput').value.trim();

    if (!reason) { alert("Please provide a reason for rejection."); return; }

    showLoading();
    document.getElementById('loadingText').innerText = "Rejecting Request...";
    try {
        await updateDoc(doc(db, "leaves", leaveId), {
            status: 'Rejected',
            rejectionReason: reason,
            reviewedAt: serverTimestamp(),
            reviewer: auth.currentUser.email
        });

        logAdminAction(db, auth.currentUser, "REJECT_LEAVE", targetUid, { leaveId: leaveId }, { reason: reason });

        rejectModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', 'Leave request rejected.', true);
    } catch (e) {
        console.error(e);
        hideLoading();
        showStatusAlert('statusMessage', `Failed: ${e.message}`, false);
    }
}

window.openEditStatusModal = function(leaveId, targetUid, currentStatus, reason) {
    document.getElementById('editLeaveId').value = leaveId;
    document.getElementById('editAuthUid').value = targetUid;
    document.getElementById('editStatusSelect').value = currentStatus;
    document.getElementById('editStatusReason').value = reason;
    window.toggleEditReason();
    editStatusModal.show();
}

window.toggleEditReason = function() {
    const stat = document.getElementById('editStatusSelect').value;
    document.getElementById('editReasonGroup').classList.toggle('d-none', stat !== 'Rejected');
}

window.submitStatusChange = async function() {
    const leaveId = document.getElementById('editLeaveId').value;
    const targetUid = document.getElementById('editAuthUid').value;
    const newStatus = document.getElementById('editStatusSelect').value;
    const reason = document.getElementById('editStatusReason').value;

    showLoading();
    document.getElementById('loadingText').innerText = "Updating Status...";
    try {
        await runTransaction(db, async (transaction) => {
            const leaveRef = doc(db, "leaves", leaveId);
            const leaveSnap = await transaction.get(leaveRef);
            const leaveData = leaveSnap.data();
            
            const isAnnual = (leaveData.type === 'Annual Leave' || leaveData.type === '年假' || leaveData.type === 'Cuti Tahunan');

            let actualDeductibleDays = leaveData.deductibleDays;
            if (actualDeductibleDays === undefined) {
                const phOverlap = await getValidPhCount(targetUid, usersMap[targetUid]?.authUid, leaveData.startDate, leaveData.endDate);
                actualDeductibleDays = Math.max(0, leaveData.days - phOverlap);
            }

            if (leaveData.status === 'Approved' && newStatus !== 'Approved' && isAnnual) {
                const userRef = doc(db, "users", targetUid);
                const userDoc = await transaction.get(userRef);
                const currentBal = userDoc.data().leave_balance?.annual || 0;
                transaction.update(userRef, { "leave_balance.annual": currentBal + actualDeductibleDays });
            }

            if (leaveData.status !== 'Approved' && newStatus === 'Approved' && isAnnual) {
                const userRef = doc(db, "users", targetUid);
                const userDoc = await transaction.get(userRef);
                const currentBal = userDoc.data().leave_balance?.annual || 0;
                if (currentBal < actualDeductibleDays) throw new Error("Insufficient Balance for this reversal!");
                transaction.update(userRef, { "leave_balance.annual": currentBal - actualDeductibleDays });
            }

            let updatePayload = {
                status: newStatus,
                reviewedAt: serverTimestamp(),
                reviewer: auth.currentUser.email,
                deductibleDays: actualDeductibleDays 
            };
            
            if (newStatus === 'Rejected') updatePayload.rejectionReason = reason;

            transaction.update(leaveRef, updatePayload);

            logAdminAction(db, auth.currentUser, "EDIT_LEAVE_STATUS", targetUid, { oldStatus: leaveData.status }, updatePayload);
        });

        editStatusModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', 'Status updated successfully.', true);
    } catch(e) {
        console.error(e);
        hideLoading();
        showStatusAlert('statusMessage', `Failed to update: ${e.message}`, false);
    }
}