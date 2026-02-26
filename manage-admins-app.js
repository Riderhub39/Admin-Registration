// manage-admins-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// 🟢 导入通用工具
import { logAdminAction, showLoading, hideLoading, showStatusAlert } from "./utils.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let promoteModal;

/**
 * 初始化函数：由 HTML 逻辑调用
 */
export async function initManageAdminsApp(userData) {
    // 🟢 二次权限校验：确保只有真正的 manager 角色能继续
    if (userData.role !== 'manager') {
        showStatusAlert('statusMessage', "Access Denied: Manager role required.", false);
        setTimeout(() => {
            window.location.replace("home.html");
        }, 1500);
        return;
    }

    if (typeof bootstrap !== 'undefined') {
        promoteModal = new bootstrap.Modal(document.getElementById('promoteModal'));
    }

    await loadAdmins();
    await loadStaffForPromotion();
    
    hideLoading(); 
    document.getElementById('mainContainer').classList.remove('d-none');
    lucide.createIcons();
}

async function loadAdmins() {
    const container = document.getElementById('adminList');
    container.innerHTML = '<div class="text-center py-5 w-100"><div class="spinner-border text-muted"></div></div>';

    try {
        const q = query(collection(db, "users"), where("role", "in", ["admin", "manager"]));
        const snap = await getDocs(q);
        
        container.innerHTML = "";
        snap.forEach(d => {
            const data = d.data();
            const isManager = data.role === 'manager';
            const col = document.createElement('div');
            col.className = 'col-md-6 col-lg-4';
            col.innerHTML = `
                <div class="card admin-card h-100 shadow-sm">
                    <div class="card-body">
                        <div class="d-flex align-items-center gap-3 mb-3">
                            <div class="avatar-circle">${data.personal?.name?.charAt(0) || 'A'}</div>
                            <div class="overflow-hidden">
                                <div class="fw-bold text-dark text-truncate">${data.personal?.name || 'Admin User'}</div>
                                <div class="small text-muted text-truncate">${data.personal?.email || '-'}</div>
                            </div>
                        </div>
                        <div class="d-flex justify-content-between align-items-center">
                            <span class="badge ${isManager ? 'badge-manager' : 'bg-primary bg-opacity-10 text-primary border border-primary-subtle'}">
                                ${data.role.toUpperCase()}
                            </span>
                            ${!isManager ? `
                                <button class="btn btn-sm btn-outline-danger border-0" onclick="window.demoteAdmin('${d.id}', '${data.personal?.name}')">
                                    <i data-lucide="user-minus" class="size-4"></i> Demote
                                </button>
                            ` : '<small class="text-muted fst-italic">Primary Owner</small>'}
                        </div>
                    </div>
                </div>
            `;
            container.appendChild(col);
        });
        lucide.createIcons();
    } catch (e) { 
        console.error(e);
        showStatusAlert('statusMessage', 'Failed to load admins.', false);
    }
}

async function loadStaffForPromotion() {
    const select = document.getElementById('staffSelect');
    try {
        const q = query(collection(db, "users"), where("role", "==", "staff"));
        const snap = await getDocs(q);
        
        select.innerHTML = '<option value="">-- Choose Staff Member --</option>';
        snap.forEach(d => {
            const data = d.data();
            if (data.status !== 'disabled') {
                const opt = document.createElement('option');
                opt.value = d.id;
                opt.textContent = `${data.personal?.name} (${data.personal?.email})`;
                select.appendChild(opt);
            }
        });
    } catch (e) {
        console.error(e);
    }
}

// --- 挂载全局方法 ---

window.openPromoteModal = () => {
    if (promoteModal) promoteModal.show();
};

window.handlePromotion = async () => {
    const staffId = document.getElementById('staffSelect').value;
    if (!staffId) {
        showStatusAlert('statusMessage', "Please select a staff member.", false);
        return;
    }

    if (!confirm("Are you sure you want to grant Admin privileges to this user?")) return;

    showLoading(); 
    try {
        const userRef = doc(db, "users", staffId);
        await updateDoc(userRef, {
            role: 'admin',
            updatedAt: serverTimestamp()
        });

        await logAdminAction(db, auth.currentUser, "PROMOTE_TO_ADMIN", staffId, {role: 'staff'}, {role: 'admin'});

        if (promoteModal) promoteModal.hide();
        await loadAdmins();
        await loadStaffForPromotion();
        
        hideLoading(); 
        showStatusAlert('statusMessage', "Staff successfully promoted to Admin.", true);
    } catch (e) { 
        hideLoading(); 
        showStatusAlert('statusMessage', "Promotion failed: " + e.message, false); 
    }
};

window.demoteAdmin = async (adminId, name) => {
    if (!confirm(`Are you sure you want to remove Admin privileges from ${name}?\nThey will be reverted to 'staff' role.`)) return;

    showLoading(); 
    try {
        const userRef = doc(db, "users", adminId);
        await updateDoc(userRef, {
            role: 'staff',
            updatedAt: serverTimestamp()
        });

        await logAdminAction(db, auth.currentUser, "DEMOTE_TO_STAFF", adminId, {role: 'admin'}, {role: 'staff'});

        await loadAdmins();
        await loadStaffForPromotion();
        
        hideLoading(); 
        showStatusAlert('statusMessage', "Admin privileges removed.", true); 
    } catch (e) { 
        hideLoading(); 
        showStatusAlert('statusMessage', "Demotion failed: " + e.message, false); 
    }
};