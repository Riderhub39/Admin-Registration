// manage-staff-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { 
    getFirestore, collection, query, where, onSnapshot, doc, 
    updateDoc, serverTimestamp, getDoc, setDoc, writeBatch, getDocs 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// 🟢 导入通用工具
import { logAdminAction, showStatusAlert, showLoading, hideLoading } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app); 
const settingsRef = doc(db, "settings", "leave_rules");

let reviewModal; 
let staffList = [];       
let pendingRequests = {}; 
let searchTerm = "";      
let leaveRulesConfig = { annual: [], medical: [] };

/**
 * 初始化页面应用
 */
export async function initManageStaffApp() {
    document.getElementById('loadingText').innerText = "Loading Staff List...";
    
    if (typeof bootstrap !== 'undefined') {
        reviewModal = new bootstrap.Modal(document.getElementById('reviewModal'));
    }
    
    initData();
    loadLeaveRules();
}

// --- 实时监听器 ---
function initData() {
    // 监听员工列表
    const q = query(collection(db, "users"), where("role", "in", ["staff", "admin"]));
    onSnapshot(q, (snapshot) => {
        staffList = [];
        snapshot.forEach(doc => staffList.push({ id: doc.id, ...doc.data() }));
        renderTable(); 
    });

    // 监听待处理的修改请求
    const reqQuery = query(collection(db, "edit_requests"), where("status", "==", "pending"));
    onSnapshot(reqQuery, (snap) => {
        pendingRequests = {}; 
        snap.forEach(doc => {
            const data = doc.data();
            pendingRequests[data.userId] = { reqId: doc.id, ...data };
        });
        renderTable(); 
    });
}

// --- 表单渲染逻辑 ---
function renderTable() {
    const tbody = document.getElementById('staffTableBody');
    const now = new Date();
    tbody.innerHTML = ''; 

    if (staffList.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">No staff found.</td></tr>';
        return;
    }

    let htmlBuffer = "";
    let visibleCount = 0;

    staffList.forEach(user => {
        // 自动检查解锁是否过期
        if (user.status === 'editable' && user.unlockExpiresAt) {
            const expiry = user.unlockExpiresAt.toDate(); 
            if (now > expiry) {
                updateDoc(doc(db, "users", user.id), { status: 'active', unlockExpiresAt: null });
                return; 
            }
        }

        // 搜索过滤
        const name = (user.personal?.name || "").toLowerCase();
        const email = (user.personal?.email || "").toLowerCase();
        const id = user.id.toLowerCase();
        const dept = (user.employment?.dept || "").toLowerCase();

        if (searchTerm && !name.includes(searchTerm) && !email.includes(searchTerm) && !id.includes(searchTerm) && !dept.includes(searchTerm)) {
            return;
        }

        visibleCount++;

        const personal = user.personal || {};
        const employment = user.employment || {};
        const status = user.status || 'active';
        
        const leaveBalance = user.leave_balance || {};
        const al = leaveBalance.annual !== undefined ? leaveBalance.annual : '-';
        const ml = leaveBalance.medical !== undefined ? leaveBalance.medical : '-';
        
        const alColor = (al !== '-' && al <= 3) ? 'text-danger' : 'text-success';
        const mlColor = (ml !== '-' && ml <= 3) ? 'text-danger' : 'text-success';

        let statusClass = 'bg-active'; 
        if(status === 'complete') statusClass = 'bg-complete';
        if(status === 'editable') statusClass = 'bg-editable';
        if(status === 'disabled') statusClass = 'bg-secondary text-white';

        const request = pendingRequests[user.id];
        const hasRequest = !!request;

        htmlBuffer += `
            <tr>
                <td class="ps-4 fw-bold text-primary">${user.id}</td>
                <td>
                    <div class="fw-bold text-dark">${personal.name || 'Unknown'}</div>
                    <small class="text-muted">${personal.email || '-'}</small>
                </td>
                <td>${employment.dept || '-'}</td>
                <td>
                    <div class="d-flex flex-column gap-1" style="font-size: 0.75rem;">
                        <div class="border rounded px-2 py-1 bg-light text-muted fw-bold d-flex justify-content-between align-items-center" style="width: 85px;">
                            <span>AL:</span> <span class="${alColor} fs-6">${al}</span>
                        </div>
                        <div class="border rounded px-2 py-1 bg-light text-muted fw-bold d-flex justify-content-between align-items-center" style="width: 85px;">
                            <span>ML:</span> <span class="${mlColor} fs-6">${ml}</span>
                        </div>
                    </div>
                </td>
                <td><span class="status-badge ${statusClass}">${status}</span></td>
                <td class="text-end pe-4">
                    <div class="action-btn-group">
                        <button class="btn btn-sm ${hasRequest ? 'btn-warning text-dark fw-bold' : 'btn-light text-muted border'}" 
                                onclick="event.stopPropagation(); ${hasRequest ? `window.openReview('${user.id}')` : ''}" 
                                ${!hasRequest ? 'disabled' : ''}>
                            <span class="notif-dot ${hasRequest ? 'active' : ''}"></span>
                            <i data-lucide="bell" class="size-3 me-1"></i> 
                            ${hasRequest ? 'Review Req' : 'No Req'}
                        </button>
                        <a href="staff_details.html?uid=${user.id}" class="btn btn-sm btn-light border text-dark">
                            Manage <i data-lucide="chevron-right" class="size-3 ms-1"></i>
                        </a>
                    </div>
                </td>
            </tr>`;
    });

    tbody.innerHTML = visibleCount === 0 ? '<tr><td colspan="6" class="text-center py-4 text-muted">No results found.</td></tr>' : htmlBuffer;
    lucide.createIcons();
}

// --- 假期规则管理 ---
async function loadLeaveRules() {
    try {
        const snap = await getDoc(settingsRef);
        if (snap.exists() && snap.data().annual) {
            leaveRulesConfig = snap.data();
        } else {
            leaveRulesConfig = {
                annual: [ {min: 0, max: 2, days: 8}, {min: 2, max: 5, days: 12}, {min: 5, max: 99, days: 16} ],
                medical: [ {min: 0, max: 2, days: 14}, {min: 2, max: 5, days: 18}, {min: 5, max: 99, days: 22} ]
            };
        }
        renderRules('annual');
        renderRules('medical');
        lucide.createIcons();
    } catch (e) { console.error("Error loading rules:", e); }
}

function renderRules(type) {
    const container = document.getElementById(`${type}RulesContainer`);
    if(!container) return;
    container.innerHTML = '';
    if(leaveRulesConfig[type]) {
        leaveRulesConfig[type].forEach(r => {
            container.appendChild(window.createRuleRow(type, r.min, r.max, r.days));
        });
    }
}

function parseAndValidateRules(type, typeName) {
    const rules = [];
    const rows = document.querySelectorAll(`#${type}RulesContainer .rule-row`);
    rows.forEach(row => {
        rules.push({
            min: parseFloat(row.querySelector('.rule-min').value),
            max: parseFloat(row.querySelector('.rule-max').value),
            days: parseInt(row.querySelector('.rule-days').value)
        });
    });
    if (rules.length === 0) throw new Error(`${typeName} must have at least one rule.`);
    rules.sort((a, b) => a.min - b.min);
    for (let i = 0; i < rules.length; i++) {
        if (isNaN(rules[i].min) || isNaN(rules[i].max) || isNaN(rules[i].days)) throw new Error(`${typeName}: Invalid numbers.`);
        if (rules[i].min >= rules[i].max) throw new Error(`${typeName}: Min must be less than Max.`);
        if (i < rules.length - 1 && rules[i].max > rules[i+1].min) {
            throw new Error(`🚫 Overlap in ${typeName} tiers detected.`);
        }
    }
    return rules;
}

// ----------------------------------------------------
// 挂载到 window 供 HTML 访问
// ----------------------------------------------------

window.updateSearch = function(val) {
    searchTerm = val.toLowerCase().trim();
    renderTable();
};

window.openReview = function(userId) {
    const request = pendingRequests[userId];
    if(!request) return;
    document.getElementById('modalRequesterName').innerText = request.empName || "Unknown Staff";
    document.getElementById('modalRequesterId').innerText = `ID: ${request.userId}`;
    document.getElementById('modalRequestContent').innerText = request.request || "No details provided.";
    document.getElementById('hiddenRequestId').value = request.reqId;
    document.getElementById('hiddenUserId').value = request.userId;
    reviewModal.show();
};

window.processDecision = async function(decision) {
    const reqId = document.getElementById('hiddenRequestId').value;
    const userId = document.getElementById('hiddenUserId').value;
    showLoading();
    try {
        if(decision === 'approve') {
            await updateDoc(doc(db, "edit_requests", reqId), { status: 'approved', reviewedAt: serverTimestamp() });
            const expiryDate = new Date(Date.now() + 5 * 60 * 1000); 
            await updateDoc(doc(db, "users", userId), { status: 'editable', unlockExpiresAt: expiryDate });
            await logAdminAction(db, auth.currentUser, "APPROVE_PROFILE_UNLOCK", userId, null, { reqId });
        } else {
            await updateDoc(doc(db, "edit_requests", reqId), { status: 'rejected', reviewedAt: serverTimestamp() });
            await logAdminAction(db, auth.currentUser, "REJECT_PROFILE_UNLOCK", userId, null, { reqId });
        }
        reviewModal.hide();
        showStatusAlert('statusMessage', `Request ${decision}d.`, true);
    } catch (error) { 
        showStatusAlert('statusMessage', `Error: ${error.message}`, false); 
    } finally { 
        hideLoading();
    }
};

window.createRuleRow = function(type, min = 0, max = 1, days = 8) {
    const div = document.createElement('div');
    div.className = 'input-group input-group-sm mb-2 rule-row';
    div.innerHTML = `
        <span class="input-group-text bg-light border-end-0">Min Yrs</span>
        <input type="number" class="form-control rule-min" value="${min}" step="0.1" min="0">
        <span class="input-group-text bg-light border-end-0 border-start-0">Max Yrs</span>
        <input type="number" class="form-control rule-max" value="${max}" step="0.1" min="0.1">
        <span class="input-group-text bg-light border-end-0 border-start-0">Days</span>
        <input type="number" class="form-control rule-days" value="${days}" min="0">
        <button type="button" class="btn btn-outline-danger px-2" onclick="this.closest('.rule-row').remove()">
            <i data-lucide="trash-2" class="size-4"></i>
        </button>
    `;
    return div;
};

window.addRuleRow = function(type) {
    document.getElementById(`${type}RulesContainer`).appendChild(window.createRuleRow(type, 0, 1, 0));
    lucide.createIcons();
};

window.saveLeaveRules = async function() {
    showLoading();
    try {
        const annualRules = parseAndValidateRules('annual', 'Annual Leave');
        const medicalRules = parseAndValidateRules('medical', 'Medical Leave');
        const newRules = { annual: annualRules, medical: medicalRules };
        const oldSnap = await getDoc(settingsRef);
        
        await setDoc(settingsRef, newRules);
        await logAdminAction(db, auth.currentUser, "UPDATE_LEAVE_RULES", "GLOBAL", oldSnap.data() || {}, newRules);
        
        hideLoading();
        showStatusAlert('statusMessage', "Leave Rules saved successfully!", true);
        bootstrap.Modal.getInstance(document.getElementById('leaveConfigModal')).hide();
    } catch (e) { 
        hideLoading();
        alert(e.message); 
    }
};

window.recalculateAllBalances = async function() {
    const currentYear = new Date().getFullYear();
    const startOfYear = `${currentYear}-01-01`;
    
    if(!confirm(`Recalculate balances for ${currentYear}?`)) return;

    showLoading();
    try {
        const ruleSnap = await getDoc(settingsRef);
        if (!ruleSnap.exists()) throw new Error("Rules missing.");
        const rules = ruleSnap.data();
        
        const leavesQ = query(collection(db, "leaves"), where("status", "==", "Approved"), where("startDate", ">=", startOfYear));
        const leaveSnaps = await getDocs(leavesQ);
        const usedMap = {}; 
        leaveSnaps.forEach(doc => {
            const d = doc.data();
            if (d.uid && d.days) {
                if (!usedMap[d.uid]) usedMap[d.uid] = { annual: 0, medical: 0 };
                if (d.type === "Annual Leave") usedMap[d.uid].annual += d.days;
                if (d.type === "Medical Leave") usedMap[d.uid].medical += d.days;
            }
        });

        const getEntitlement = (yrs, arr) => {
            const rule = arr.find(r => yrs >= r.min && yrs < r.max);
            return rule ? rule.days : 0; 
        };

        const staffSnap = await getDocs(query(collection(db, "users"), where("role", "in", ["staff", "admin"])));
        const batch = writeBatch(db);
        let count = 0;

        staffSnap.forEach((docSnap) => {
            const d = docSnap.data();
            if (d.employment?.joinDate) {
                const yrs = (new Date() - new Date(d.employment.joinDate)) / (1000 * 60 * 60 * 24 * 365.25);
                const aE = getEntitlement(yrs, rules.annual || []);
                const mE = getEntitlement(yrs, rules.medical || []);
                const aU = usedMap[docSnap.id]?.annual || 0;
                const mU = usedMap[docSnap.id]?.medical || 0;

                batch.update(doc(db, "users", docSnap.id), { 
                    "leave_balance.annual": aE - aU, 
                    "leave_balance.medical": mE - mU,
                    "leave_balance.total_annual": aE,
                    "leave_balance.total_medical": mE,
                    "meta.balanceLastUpdated": serverTimestamp(), 
                    "meta.balanceYear": currentYear 
                });
                count++;
            }
        });

        await batch.commit();
        await logAdminAction(db, auth.currentUser, "BATCH_RECALCULATE_LEAVES", "ALL_STAFF", null, { impactedUsers: count, year: currentYear });
        hideLoading();
        showStatusAlert('statusMessage', `Updated ${count} staff balances.`, true);
    } catch (e) {
        hideLoading();
        showStatusAlert('statusMessage', `Error: ${e.message}`, false);
    }
};