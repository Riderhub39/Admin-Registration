// leave-approval-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
// 🟢 确保引入了 getDocs
import { getFirestore, collection, query, where, getDocs, onSnapshot, doc, runTransaction, updateDoc, serverTimestamp, limit, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

import { normalizeDate, logAdminAction, formatDate, formatDateTime, showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let fullHistoryList = [];
let attachmentModal, rejectModal, editStatusModal, addLeaveModalInst;
let usersMap = {}; // 🟢 缓存员工信息

export async function initLeaveApprovalApp() {
    document.getElementById('loadingText').innerText = "Loading Requests...";
    document.getElementById('todayDate').innerText = new Date().toLocaleDateString('en-GB');
    
    if (typeof bootstrap !== 'undefined') {
        attachmentModal = new bootstrap.Modal(document.getElementById('attachmentModal'));
        rejectModal = new bootstrap.Modal(document.getElementById('rejectModal'));
        editStatusModal = new bootstrap.Modal(document.getElementById('editStatusModal'));
        addLeaveModalInst = new bootstrap.Modal(document.getElementById('addLeaveModal')); // 🟢 初始化添加表单
    }

    await fetchUsers(); // 🟢 获取用户列表用于下拉框
    listenToPendingLeaves();
    listenToLeaveHistory();
}

// 🟢 获取所有有效员工
async function fetchUsers() {
    const snap = await getDocs(query(collection(db, "users"), where("role", "==", "staff")));
    const staffSelect = document.getElementById('addLeaveStaff');
    if(staffSelect) staffSelect.innerHTML = '<option value="">-- Select Employee --</option>';
    
    let users = [];
    snap.forEach(docSnap => {
        const d = docSnap.data();
        if (d.status !== 'disabled') {
            users.push({
                id: docSnap.id,
                authUid: d.authUid || "",
                name: d.personal?.name || d.name || "Unknown Staff",
                email: d.personal?.email || ""
            });
        }
    });
    
    // 按字母排序并填充下拉框
    users.sort((a,b) => a.name.localeCompare(b.name)).forEach(u => {
        usersMap[u.id] = u;
        if(staffSelect) {
            staffSelect.innerHTML += `<option value="${u.id}">${u.name}</option>`;
        }
    });
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
                                    <span class="fw-bold text-dark">${data.days} Day(s)</span>
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
                                    <button class="btn btn-success fw-bold shadow-sm" onclick="window.approveLeave('${data.id}', '${data.uid}', ${data.days}, '${data.type}')">
                                        <i data-lucide="check" class="size-4 me-1"></i> Approve
                                    </button>
                                    <button class="btn btn-outline-danger fw-bold" onclick="window.openRejectModal('${data.id}', '${data.uid}')">
                                        <i data-lucide="x" class="size-4 me-1"></i> Reject
                                    </button>
                                    ${data.attachmentUrl 
                                        ? `<button class="btn btn-sm btn-light text-primary border" onclick="window.viewAttachment('${data.attachmentUrl}')"><i data-lucide="paperclip" class="size-4 me-1"></i> View Proof</button>`
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

        tbody.innerHTML += `
            <tr>
                <td class="ps-4">
                    <div class="fw-bold text-dark">${data.empName || 'Unknown'}</div>
                    <div class="small text-muted" style="font-size: 0.75rem;">${data.uid}</div>
                </td>
                <td class="fw-bold ${typeClass}">${data.type}</td>
                <td>
                    <div class="small text-dark">${formatDate(data.startDate)}</div>
                    <div class="small text-muted">to ${formatDate(data.endDate)}</div>
                </td>
                <td class="fw-bold">${data.days}</td>
                <td>
                    <span class="badge ${isApprove ? 'bg-success bg-opacity-10 text-success border border-success-subtle' : 'bg-danger bg-opacity-10 text-danger border border-danger-subtle'}">
                        ${data.status}
                    </span>
                </td>
                <td class="text-end pe-4">
                    <div class="small text-dark">${reviewStr}</div>
                    <button class="btn btn-link btn-sm p-0 text-decoration-none" onclick="window.openEditStatusModal('${data.id}', '${data.uid}', '${data.status}', '${data.reason || ''}')">Edit</button>
                </td>
            </tr>
        `;
    });
}

window.approveLeave = async function(leaveId, targetUid, days, type) {
    if (!confirm(`Approve ${days} day(s) of ${type}?`)) return;

    showLoading();
    try {
        await runTransaction(db, async (transaction) => {
            const leaveRef = doc(db, "leaves", leaveId);
            const userRef = doc(db, "users", targetUid);
            const userDoc = await transaction.get(userRef);

            const isAnnual = (type === 'Annual Leave' || type === '年假' || type === 'Cuti Tahunan');
            let currentBalance = 0;

            if (isAnnual) {
                currentBalance = userDoc.data().leave_balance?.annual || 0;
                if (currentBalance < days) throw new Error(`Insufficient Balance! Current: ${currentBalance}, Required: ${days}`);
                transaction.update(userRef, { "leave_balance.annual": currentBalance - days });
            } 
            
            transaction.update(leaveRef, { 
                status: 'Approved', 
                reviewedAt: serverTimestamp(), 
                reviewer: auth.currentUser.email, 
                isPayrollDeductible: (type === 'Unpaid Leave'), 
                deductibleDays: days 
            });

            logAdminAction(db, auth.currentUser, "APPROVE_LEAVE", targetUid, 
                { leaveId: leaveId, oldBalance: currentBalance }, 
                { daysDeducted: isAnnual ? days : 0, type: type }
            );
        });
        hideLoading();
        showStatusAlert('statusMessage', 'Leave approved successfully.', true);
    } catch (e) { 
        console.error(e); 
        hideLoading();
        showStatusAlert('statusMessage', `Failed: ${e.message}`, false); 
    }
}

// 🟢 -------------------- 管理员手动添加请假 (Add Leave) --------------------
window.openAddLeaveModal = () => {
    document.getElementById('addLeaveStaff').value = "";
    document.getElementById('addLeaveType').value = "Annual Leave";
    document.getElementById('addLeaveStart').value = "";
    document.getElementById('addLeaveEnd').value = "";
    document.getElementById('addLeaveReason').value = "";
    addLeaveModalInst.show();
};

window.submitAddLeave = async () => {
    const staffId = document.getElementById('addLeaveStaff').value;
    const type = document.getElementById('addLeaveType').value;
    const startStr = document.getElementById('addLeaveStart').value;
    const endStr = document.getElementById('addLeaveEnd').value;
    const reason = document.getElementById('addLeaveReason').value || "Added by Admin";

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

    const days = Math.round((eDate - sDate) / (1000 * 60 * 60 * 24)) + 1;
    const user = usersMap[staffId];
    if (!confirm(`Add ${days} day(s) of ${type} for ${user.name}?`)) return;

    showLoading();
    try {
        await runTransaction(db, async (transaction) => {
            const userRef = doc(db, "users", staffId);
            const userDoc = await transaction.get(userRef);
            
            let oldBalance = 0;
            if (type === 'Annual Leave') {
                oldBalance = userDoc.data().leave_balance?.annual || 0;
                if (oldBalance < days) {
                    throw new Error(`Insufficient Annual Leave Balance! Current: ${oldBalance}, Required: ${days}`);
                }
                // 扣除年假
                transaction.update(userRef, { "leave_balance.annual": oldBalance - days });
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
                days: days,
                reason: reason,
                status: 'Approved', // 🟢 管理员直接添加即刻生效
                appliedAt: serverTimestamp(),
                reviewedAt: serverTimestamp(),
                reviewer: auth.currentUser.email,
                isPayrollDeductible: (type === 'Unpaid Leave')
            };
            
            transaction.set(newLeaveRef, leaveData);

            logAdminAction(db, auth.currentUser, "MANUAL_ADD_LEAVE", staffId, 
                { oldBalance: oldBalance }, 
                leaveData
            );
        });

        addLeaveModalInst.hide();
        hideLoading();
        showStatusAlert('statusMessage', 'Leave manually added and approved successfully.', true);
    } catch (e) {
        console.error(e);
        hideLoading();
        showStatusAlert('statusMessage', `Failed: ${e.message}`, false);
    }
};

window.viewAttachment = function(url) {
    const img = document.getElementById('attachmentImg');
    const msg = document.getElementById('noAttachmentMsg');
    if(url) { 
        img.src = url; img.classList.remove('d-none'); msg.classList.add('d-none'); 
    } else { 
        img.classList.add('d-none'); msg.classList.remove('d-none'); 
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
    try {
        await runTransaction(db, async (transaction) => {
            const leaveRef = doc(db, "leaves", leaveId);
            const leaveSnap = await transaction.get(leaveRef);
            const leaveData = leaveSnap.data();
            
            const isAnnual = (leaveData.type === 'Annual Leave' || leaveData.type === '年假' || leaveData.type === 'Cuti Tahunan');

            if (leaveData.status === 'Approved' && newStatus !== 'Approved' && isAnnual) {
                const userRef = doc(db, "users", targetUid);
                const userDoc = await transaction.get(userRef);
                const currentBal = userDoc.data().leave_balance?.annual || 0;
                transaction.update(userRef, { "leave_balance.annual": currentBal + leaveData.days });
            }

            if (leaveData.status !== 'Approved' && newStatus === 'Approved' && isAnnual) {
                const userRef = doc(db, "users", targetUid);
                const userDoc = await transaction.get(userRef);
                const currentBal = userDoc.data().leave_balance?.annual || 0;
                if (currentBal < leaveData.days) throw new Error("Insufficient Balance for this reversal!");
                transaction.update(userRef, { "leave_balance.annual": currentBal - leaveData.days });
            }

            let updatePayload = {
                status: newStatus,
                reviewedAt: serverTimestamp(),
                reviewer: auth.currentUser.email
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