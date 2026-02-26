// leave-approval-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, onSnapshot, doc, runTransaction, updateDoc, serverTimestamp, limit, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// 🟢 导入 utils 的公用方法
import { normalizeDate, logAdminAction, formatDate, formatDateTime, showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let fullHistoryList = [];
let attachmentModal, rejectModal, editStatusModal;

export function initLeaveApprovalApp() {
    document.getElementById('loadingText').innerText = "Loading Requests...";
    document.getElementById('todayDate').innerText = new Date().toLocaleDateString('en-GB');
    
    if (typeof bootstrap !== 'undefined') {
        attachmentModal = new bootstrap.Modal(document.getElementById('attachmentModal'));
        rejectModal = new bootstrap.Modal(document.getElementById('rejectModal'));
        editStatusModal = new bootstrap.Modal(document.getElementById('editStatusModal'));
    }

    initListeners();
    lucide.createIcons();
}

function initListeners() {
    const qPending = query(collection(db, "leaves"), where("status", "==", "Pending"));
    onSnapshot(qPending, (snapshot) => {
        const list = [];
        snapshot.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
        list.sort((a,b) => (a.appliedAt?.seconds || 0) - (b.appliedAt?.seconds || 0));
        renderPending(list);
        updateBadge(list.length);
    });

    const qHistory = query(collection(db, "leaves"), where("status", "in", ["Approved", "Rejected"]), limit(200));
    onSnapshot(qHistory, (snapshot) => {
        const list = [];
        snapshot.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
        list.sort((a,b) => (b.reviewedAt?.seconds || 0) - (a.reviewedAt?.seconds || 0));
        fullHistoryList = list;
        window.filterHistory();
        
        // 数据加载完后隐藏 loading 遮罩
        hideLoading();
        document.getElementById('mainContainer').classList.remove('d-none');
    });
}

// --- Render Functions ---
function renderPending(list) {
    const tbody = document.getElementById('pendingTable');
    tbody.innerHTML = '';
    
    if(list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-5 text-muted"><i data-lucide="check-circle" class="size-8 mb-2 text-success"></i><br>All caught up! No pending requests.</td></tr>';
        lucide.createIcons();
        return;
    }
    
    list.forEach(item => {
        const badgeClass = getBadgeClass(item.type);
        const displayName = item.empName || item.email || 'Unknown User';
        const tr = document.createElement('tr');
        
        tr.innerHTML = `
            <td class="ps-4">
                <div class="d-flex align-items-center gap-2">
                    <div class="avatar-initial">${displayName.charAt(0).toUpperCase()}</div>
                    <div>
                        <div class="fw-bold text-dark">${displayName}</div>
                        <small class="text-muted">ID: ${item.uid || '-'}</small>
                    </div>
                </div>
            </td>
            <td><span class="badge ${badgeClass} border">${item.type}</span></td>
            <td>
                <div class="fw-bold text-dark">${formatDate(item.startDate)} <span class="text-muted fw-normal">to</span></div>
                <div class="fw-bold text-dark">${formatDate(item.endDate)}</div>
                <small class="text-primary fw-bold">${item.days} Day(s)</small>
            </td>
            <td style="max-width: 250px;">
                <div class="text-truncate mb-1" title="${item.reason}">${item.reason || '-'}</div>
                ${item.attachmentUrl ? `<button class="btn btn-sm btn-light border text-primary" onclick="window.viewAttachment('${item.attachmentUrl}')"><i data-lucide="paperclip" class="size-3 me-1"></i> View Proof</button>` : '<small class="text-muted fst-italic">No attachment</small>'}
            </td>
            <td class="text-end pe-4">
                <button class="btn btn-sm btn-outline-danger me-1" onclick="window.openRejectModal('${item.id}')">Reject</button>
                <button class="btn btn-sm btn-success fw-bold text-white" onclick="window.handleApprove('${item.id}', '${item.authUid || item.uid}')">Approve</button>
            </td>`;
        tbody.appendChild(tr);
    });
    lucide.createIcons();
}

function renderHistory(list) {
    const tbody = document.getElementById('historyTable');
    tbody.innerHTML = '';
    
    if(list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-5 text-muted">No history found matching filters.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        let statusClass = item.status === 'Approved' ? 'status-approved' : 'status-rejected';
        const displayName = item.empName || item.email || '-';
        let reasonNote = item.status === 'Rejected' && item.rejectionReason ? `<div class="mt-1 text-danger small fw-bold"><i data-lucide="alert-circle" class="size-3 me-1"></i>Reason: ${item.rejectionReason}</div>` : '';
        
        const attachmentBtn = item.attachmentUrl 
            ? `<button class="btn btn-xs btn-light border text-primary mt-1" onclick="window.viewAttachment('${item.attachmentUrl}')"><i data-lucide="paperclip" class="size-3 me-1"></i> Proof</button>` 
            : '';

        const editBtn = `<button class="btn btn-xs btn-outline-secondary ms-2" onclick="window.openEditStatusModal('${item.id}', '${item.status}', '${item.authUid || item.uid}')" title="Edit Status"><i data-lucide="edit-2" class="size-3"></i></button>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="ps-4 fw-bold">${displayName}</td>
            <td>${item.type}</td>
            <td>
                <div class="small">${formatDate(item.startDate)} - ${formatDate(item.endDate)}</div>
                <span class="text-muted fw-bold" style="font-size:0.75rem">(${item.days} days)</span>
            </td>
            <td style="max-width: 200px;">
                <div class="text-truncate" title="${item.reason || ''}">${item.reason || '-'}</div>
                ${attachmentBtn}
            </td>
            <td>
                <span class="badge ${statusClass} border text-uppercase">${item.status}</span>
                ${reasonNote}
            </td>
            <td class="text-end pe-4">
                <span class="text-muted small me-2">${formatDateTime(item.reviewedAt)}</span>
                ${editBtn}
            </td>`;
        tbody.appendChild(tr);
    });
    lucide.createIcons();
}

function updateBadge(count) {
    const badge = document.getElementById('pendingBadge');
    if(badge) {
        badge.innerText = count;
        count > 0 ? badge.classList.remove('d-none') : badge.classList.add('d-none');
    }
}

function getBadgeClass(type) {
    if(type && type.includes('Medical')) return 'badge-leave-medical';
    if(type && type.includes('Unpaid')) return 'badge-leave-unpaid';
    return 'badge-leave-annual';
}

// --- 暴露给 window 的方法 ---

window.toggleCustomDate = function() {
    const period = document.getElementById('filterPeriod').value;
    const customInput = document.getElementById('customDateContainer');
    if (period === 'custom') {
        customInput.classList.remove('d-none');
    } else {
        customInput.classList.add('d-none');
        document.getElementById('filterDateInput').value = ''; 
        window.filterHistory();
    }
}

window.filterHistory = function() {
    const searchText = document.getElementById('filterSearch').value.toLowerCase();
    const typeFilter = document.getElementById('filterType').value;
    const statusFilter = document.getElementById('filterStatus').value;
    const periodFilter = document.getElementById('filterPeriod').value;
    const customDate = document.getElementById('filterDateInput').value;

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); 

    const filteredList = fullHistoryList.filter(item => {
        const name = (item.empName || '').toLowerCase();
        const uid = (item.uid || '').toLowerCase();
        const matchSearch = name.includes(searchText) || uid.includes(searchText);
        
        const matchType = typeFilter === "" || item.type === typeFilter;
        const matchStatus = statusFilter === "" || item.status === statusFilter;

        let matchDate = true;
        let itemDate = null;
        if (item.startDate) itemDate = new Date(item.startDate);

        if (itemDate) {
            const itemYear = itemDate.getFullYear();
            const itemMonth = itemDate.getMonth();
            
            if (periodFilter === 'this_year') matchDate = (itemYear === currentYear);
            else if (periodFilter === 'this_month') matchDate = (itemYear === currentYear && itemMonth === currentMonth);
            else if (periodFilter === 'last_month') {
                const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                matchDate = (itemYear === lastMonthDate.getFullYear() && itemMonth === lastMonthDate.getMonth());
            } else if (periodFilter === 'custom' && customDate) {
                matchDate = (item.startDate === customDate); 
            }
        }
        return matchSearch && matchType && matchStatus && matchDate;
    });
    renderHistory(filteredList);
}

window.resetFilters = function() {
    document.getElementById('filterSearch').value = "";
    document.getElementById('filterType').value = "";
    document.getElementById('filterStatus').value = "";
    document.getElementById('filterPeriod').value = "all";
    window.toggleCustomDate(); 
    window.filterHistory();
}

window.openEditStatusModal = function(id, status, authUid) {
    document.getElementById('editLeaveId').value = id;
    document.getElementById('editCurrentStatus').value = status;
    document.getElementById('editAuthUid').value = authUid;
    
    const sel = document.getElementById('editNewStatus');
    sel.value = status; 
    
    sel.onchange = () => {
        document.getElementById('editReasonGroup').classList.toggle('d-none', sel.value !== 'Rejected');
    };
    sel.onchange(); 

    if(editStatusModal) editStatusModal.show();
}

window.submitStatusChange = async function() {
    const id = document.getElementById('editLeaveId').value;
    const oldStatus = document.getElementById('editCurrentStatus').value;
    const newStatus = document.getElementById('editNewStatus').value;
    const authUid = document.getElementById('editAuthUid').value;
    const reason = document.getElementById('editStatusReason').value;

    if (oldStatus === newStatus) { editStatusModal.hide(); return; }
    if (newStatus === 'Rejected' && !reason.trim()) { 
        showStatusAlert('statusMessage', 'Please provide a rejection reason.', false); 
        return; 
    }
    if(!confirm(`⚠️ Warning:\nChanging status from ${oldStatus} to ${newStatus}.\n\nThis will auto-calculate the employee's Leave Balance.\nContinue?`)) return;

    showLoading(); 

    try {
        await runTransaction(db, async (transaction) => {
            const leaveRef = doc(db, "leaves", id);
            const userRef = doc(db, "users", authUid);
            
            const leaveDoc = await transaction.get(leaveRef);
            if (!leaveDoc.exists()) throw new Error("Leave record not found.");
            const leaveData = leaveDoc.data();
            const days = leaveData.days;
            const type = leaveData.type;

            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists()) throw new Error("User not found for balance update.");
            
            const userData = userDoc.data();
            const currentBalance = userData.leave_balance?.annual || 0;
            let newBalance = currentBalance;
            const isAnnual = (type === 'Annual Leave');

            // 1. REVERT OLD EFFECT
            if (oldStatus === 'Approved' && isAnnual) newBalance += days;

            // 2. APPLY NEW EFFECT
            if (newStatus === 'Approved' && isAnnual) {
                if (newBalance < days) throw new Error("Cannot approve: User has insufficient balance.");
                newBalance -= days;
            }

            // 3. Update User Balance (Only if Annual)
            if (isAnnual && newBalance !== currentBalance) {
                transaction.update(userRef, { "leave_balance.annual": newBalance });
            }

            // 4. Update Leave Doc
            const updateData = { status: newStatus, reviewedAt: serverTimestamp(), reviewer: auth.currentUser.email };
            if (newStatus === 'Rejected') updateData.rejectionReason = reason;
            if (type === 'Unpaid Leave') updateData.isPayrollDeductible = (newStatus === 'Approved');

            transaction.update(leaveRef, updateData);
            
            logAdminAction(db, auth.currentUser, "MODIFY_LEAVE_STATUS", authUid, 
                { leaveId: id, oldStatus: oldStatus, oldBalance: currentBalance }, 
                { newStatus: newStatus, newBalance: newBalance, reason: reason }
            );
        });
        if(editStatusModal) editStatusModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', 'Status updated and balance recalculated successfully!', true); 
    } catch (e) {
        console.error(e); 
        hideLoading();
        showStatusAlert('statusMessage', `Update Failed: ${e.message}`, false);
    }
}

window.openRejectModal = function(leaveId) {
    document.getElementById('hiddenRejectLeaveId').value = leaveId;
    document.getElementById('rejectReasonInput').value = "";
    if(rejectModal) rejectModal.show();
}

window.submitRejection = async function() {
    const leaveId = document.getElementById('hiddenRejectLeaveId').value;
    const reason = document.getElementById('rejectReasonInput').value.trim();
    
    if(!reason) { 
        showStatusAlert('statusMessage', 'Please enter a reason.', false); 
        return; 
    }
    
    const btn = document.querySelector('#rejectModal .btn-danger');
    if(btn) { btn.disabled = true; btn.innerText = "Processing..."; }
    showLoading(); 
    
    try {
        const oldSnap = await getDoc(doc(db, "leaves", leaveId));
        
        await updateDoc(doc(db, "leaves", leaveId), {
            status: 'Rejected', rejectionReason: reason, reviewedAt: serverTimestamp(), reviewer: auth.currentUser.email
        });
        
        await logAdminAction(db, auth.currentUser, "REJECT_LEAVE", oldSnap.data()?.uid, oldSnap.data(), { status: 'Rejected', reason: reason });

        if(rejectModal) rejectModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', 'Leave request rejected.', true);
    } catch (error) { 
        console.error(error); 
        hideLoading();
        showStatusAlert('statusMessage', `Error: ${error.message}`, false); 
    } finally { 
        if(btn) { btn.disabled = false; btn.innerText = "Confirm Reject"; }
    }
}

window.handleApprove = async function(leaveId, userId) {
    if(!confirm(`Confirm APPROVE this leave request?`)) return;
    
    showLoading(); 

    try {
        await runTransaction(db, async (transaction) => {
            const leaveRef = doc(db, "leaves", leaveId);
            const userRef = doc(db, "users", userId);
            
            const leaveDoc = await transaction.get(leaveRef);
            if (!leaveDoc.exists()) throw new Error(`Leave request not found.`);
            
            const leaveData = leaveDoc.data();
            if (leaveData.status !== 'Pending') throw new Error(`This request is already ${leaveData.status}.`);
            
            const days = leaveData.days;
            const type = leaveData.type;

            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists()) throw new Error(`User document ${userId} not found.`);
            
            const userData = userDoc.data();
            const isAnnual = (type === 'Annual Leave');
            const currentBalance = userData.leave_balance?.annual !== undefined ? userData.leave_balance.annual : 14; 
            
            if (isAnnual) {
                if (currentBalance < days) throw new Error(`Insufficient Annual Leave Balance! Current: ${currentBalance}, Required: ${days}`);
                transaction.update(userRef, { "leave_balance.annual": currentBalance - days });
            } 
            
            transaction.update(leaveRef, { 
                status: 'Approved', 
                reviewedAt: serverTimestamp(), 
                reviewer: auth.currentUser.email, 
                isPayrollDeductible: (type === 'Unpaid Leave'), 
                deductibleDays: days 
            });

            logAdminAction(db, auth.currentUser, "APPROVE_LEAVE", userId, 
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

window.viewAttachment = function(url) {
    const img = document.getElementById('attachmentImg');
    const msg = document.getElementById('noAttachmentMsg');
    if(url) { 
        img.src = url; img.classList.remove('d-none'); msg.classList.add('d-none'); 
    } else { 
        img.classList.add('d-none'); msg.classList.remove('d-none'); 
    }
    if(attachmentModal) attachmentModal.show();
}