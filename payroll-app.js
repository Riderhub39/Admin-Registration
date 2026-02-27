import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, getDoc, onSnapshot, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// 🟢 导入 utils 所有公用方法
import { formatMoney, formatTime, calculateStatutoryAmount, msToHM, logAdminAction, showLoading, hideLoading, showStatusAlert } from './utils.js';
import { requireAdmin } from './auth-guard.js';

// 仅保留 formatMoney 因为部分内联 JS(如果存在的话) 可能需要
window.formatMoney = formatMoney;

window.onerror = function(msg) {
    const loadingText = document.getElementById('loadingText');
    if(loadingText) { loadingText.innerText = "Error: " + msg; loadingText.classList.add('text-danger'); }
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app); 

let currentPayrollData = [];
let staffMap = {}; 
let formModal, printModal, advancesModal, settingsModal;
let globalSettings = { calcMode: 'daily', satMultiplier: 1.0, lateMode: 'minutes', lateFixedAmount: 10 }; 

requireAdmin(app, db, async (user) => {
    try {
        showLoading(); // 🟢 使用公用 Loading
        
        if (typeof bootstrap !== 'undefined') {
            formModal = new bootstrap.Modal(document.getElementById('payslipFormModal'));
            printModal = new bootstrap.Modal(document.getElementById('printModal'));
            advancesModal = new bootstrap.Modal(document.getElementById('advancesModal'));
            settingsModal = new bootstrap.Modal(document.getElementById('settingsModal'));
        }

        const now = new Date();
        const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        document.getElementById('globalMonthPicker').value = monthStr;
        document.getElementById('formMonthPicker').value = monthStr;

        await loadSettings();
        await loadStaffData(); 
        await window.loadPayroll();
        listenToAdvances(); 

        document.getElementById('mainContainer').classList.remove('d-none');
    } catch (e) {
        console.error("Init Error:", e);
        showStatusAlert('statusMessage', 'Failed to initialize Payroll system.', false); // 🟢 使用 Toast
    } finally {
        hideLoading(); // 🟢
        lucide.createIcons();
    }
});

// ==========================================
// 1. SETTINGS MANAGEMENT
// ==========================================
async function loadSettings() {
    try {
        const snap = await getDoc(doc(db, "settings", "payroll_config"));
        if (snap.exists()) globalSettings = { ...globalSettings, ...snap.data() };
        
        document.getElementById('configCalcMode').value = globalSettings.calcMode;
        document.getElementById('configSatMulti').value = globalSettings.satMultiplier;
        document.getElementById('configLateMode').value = globalSettings.lateMode || 'minutes';
        document.getElementById('configLateAmount').value = globalSettings.lateFixedAmount || 10;
        
        window.toggleSettingsView();
        window.toggleLateSettings();
    } catch (e) { console.error("Settings load error", e); }
}

window.toggleSettingsView = () => {
    const mode = document.getElementById('configCalcMode').value;
    const hint = document.getElementById('calcModeHint');
    const satBox = document.getElementById('satConfigBox');
    if (mode === 'hourly') {
        hint.innerText = "Pays based on strictly total hours worked.";
        satBox.classList.add('d-none');
    } else {
        hint.innerText = "Pays based on days worked + paid leave days.";
        satBox.classList.remove('d-none');
    }
};

window.toggleLateSettings = () => {
    const mode = document.getElementById('configLateMode').value;
    const amountBox = document.getElementById('lateFixedAmountBox');
    mode === 'times' ? amountBox.classList.remove('d-none') : amountBox.classList.add('d-none');
};

window.saveSettings = async () => {
    const newConfig = { 
        calcMode: document.getElementById('configCalcMode').value, 
        satMultiplier: parseFloat(document.getElementById('configSatMulti').value), 
        lateMode: document.getElementById('configLateMode').value, 
        lateFixedAmount: parseFloat(document.getElementById('configLateAmount').value) || 0 
    };
    
    showLoading(); // 🟢
    try {
        const oldSnap = await getDoc(doc(db, "settings", "payroll_config"));
        await setDoc(doc(db, "settings", "payroll_config"), newConfig, { merge: true });
        
        await logAdminAction(db, auth.currentUser, "UPDATE_PAYROLL_SETTINGS", "GLOBAL", oldSnap.exists() ? oldSnap.data() : null, newConfig);

        globalSettings = { ...globalSettings, ...newConfig };
        settingsModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', "Settings Saved! Please re-save Drafts.", true); // 🟢
    } catch (e) { 
        hideLoading();
        showStatusAlert('statusMessage', "Error saving settings: " + e.message, false); 
    }
};

window.openSettingsModal = () => settingsModal.show();

// ==========================================
// 2. SALARY ADVANCES
// ==========================================
function listenToAdvances() {
    onSnapshot(query(collection(db, "salary_advances"), where("status", "==", "Pending")), (snap) => {
        const badge = document.getElementById('advanceBadge');
        if (snap.empty) badge.classList.add('d-none');
        else { badge.classList.remove('d-none'); badge.innerText = snap.size; }
    });
}

window.openAdvancesModal = async () => {
    const listDiv = document.getElementById('advancesList');
    listDiv.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">Loading...</td></tr>';
    advancesModal.show();

    try {
        const snap = await getDocs(query(collection(db, "salary_advances")));
        let html = ""; let count = 0;

        snap.forEach(d => {
            const data = d.data();
            if(data.isDeducted || data.status === 'Rejected') return; 

            count++;
            let actionHtml = "";
            let statusBadge = `<span class="badge bg-warning text-dark px-2 py-1">Pending</span>`;

            if (data.status === 'Pending') {
                actionHtml = `
                    <button class="btn btn-sm btn-success fw-bold px-3 py-1 me-1 shadow-sm" onclick="window.updateAdvanceStatus('${d.id}', 'Approved')">Approve</button>
                    <button class="btn btn-sm btn-outline-danger fw-bold px-3 py-1" onclick="window.updateAdvanceStatus('${d.id}', 'Rejected')">Reject</button>
                `;
            } else if (data.status === 'Approved') {
                statusBadge = `<span class="badge bg-success px-2 py-1"><i data-lucide="check" class="size-3 me-1"></i> Approved</span>`;
                actionHtml = `<button class="btn btn-sm btn-light border text-muted py-1" onclick="window.updateAdvanceStatus('${d.id}', 'Rejected')">Revoke</button>`;
            }

            html += `
                <tr class="align-middle">
                    <td class="ps-4"><div class="fw-bold text-dark">${data.empName || '-'}</div><small class="text-muted">${data.empCode || ''}</small></td>
                    <td class="text-danger fw-bold fs-6">RM ${formatMoney(data.amount)}</td>
                    <td class="text-secondary">${data.reason || '-'}</td>
                    <td>${statusBadge}</td>
                    <td class="text-end pe-4">${actionHtml}</td>
                </tr>
            `;
        });
        
        listDiv.innerHTML = count > 0 ? html : '<tr><td colspan="5" class="text-center py-5 text-muted fw-bold">No pending requests found.</td></tr>';
        lucide.createIcons();
    } catch (e) { console.error(e); }
};

window.updateAdvanceStatus = async (id, status) => {
    showLoading(); // 🟢
    try {
        const docRef = doc(db, "salary_advances", id);
        const oldSnap = await getDoc(docRef);
        const oldData = oldSnap.data();

        await updateDoc(docRef, { status: status, updatedAt: serverTimestamp() });
        
        await logAdminAction(db, auth.currentUser, "APPROVE_ADVANCE", oldData.uid, { status: oldData.status }, { status: status, amount: oldData.amount });

        hideLoading();
        showStatusAlert('statusMessage', `Advance marked as ${status}`, true); // 🟢
        window.openAdvancesModal(); 
    } catch (e) { 
        hideLoading();
        showStatusAlert('statusMessage', "Error: " + e.message, false); 
    }
};

// ==========================================
// 3. CORE PAYROLL LOGIC
// ==========================================
async function loadStaffData() {
    const snap = await getDocs(query(collection(db, "users")));
    staffMap = {}; 
    const select = document.getElementById('staffSelect');
    select.innerHTML = '<option value="">-- Choose Staff --</option>';

    snap.forEach(doc => {
        const s = doc.data();
        if (s.status === 'disabled' ||  s.role === 'manager') return;
        
        const personal = s.personal || {}; 
        const displayName = personal.name || s.name || 'Unknown Staff';
        
        staffMap[doc.id] = { 
            id: doc.id, authUid: s.authUid, ...s, 
            displayName: displayName, 
            displayId: personal.empCode || s.staffId || '--'
        };
        select.innerHTML += `<option value="${doc.id}">${displayName} (${personal.empCode || 'No ID'})</option>`;
    });
}

window.autoFillStaffData = async () => {
    const uid = document.getElementById('staffSelect').value;
    const monthStr = document.getElementById('formMonthPicker').value;
    if (!uid || !monthStr) return;

    const staff = staffMap[uid]; 
    
    const isHourly = globalSettings.calcMode === 'hourly';
    document.getElementById('calcModeBadge').innerText = isHourly ? 'Mode: Hourly Rate' : 'Mode: Daily Rate';
    document.getElementById('calcModeBadge').className = isHourly ? 'badge bg-primary me-2' : 'badge bg-success me-2';
    document.getElementById('boxStdDays').classList.toggle('d-none', isHourly);
    document.getElementById('boxHourlyRate').classList.toggle('d-none', !isHourly);

    let totalAdv = 0; let advIds = [];
    if(staff) {
        try {
            const targetIds = [String(uid)];
            if (staff.authUid) targetIds.push(String(staff.authUid));
            
            const advSnap = await getDocs(query(collection(db, "salary_advances"), where("uid", "in", targetIds), where("status", "==", "Approved")));
            advSnap.forEach(d => {
                const adv = d.data();
                if (!adv.isDeducted) { totalAdv += adv.amount; advIds.push(d.id); }
            });
        } catch (e) { console.error("Error fetching advances", e); }
    }

    if(staff) {
        document.getElementById('inpBasic').value = staff.payroll?.basic || 0;
        document.getElementById('inpAdvance').value = totalAdv;
        document.getElementById('pendingAdvanceIds').value = JSON.stringify(advIds);
        window.recalcStatutoryAndTotals(); 
    }

    showLoading(); // 🟢
    await calculateAttendanceStats(uid, monthStr);
    window.calcTotals(true); 
    hideLoading(); // 🟢
};

window.recalcStatutoryAndTotals = () => {
    const uid = document.getElementById('staffSelect').value;
    const staff = staffMap[uid]; 
    const basicSalary = parseFloat(document.getElementById('inpBasic').value) || 0;

    if (staff && staff.statutory) {
        const epfRaw = staff.statutory.epf?.contrib || '';
        const eisRaw = staff.statutory.eis || '';

        document.getElementById('hintEPF').innerText = epfRaw ? `(${epfRaw}${epfRaw.toString().includes('%') ? '' : '%'})` : '';
        document.getElementById('hintEIS').innerText = eisRaw ? `(${eisRaw}${eisRaw.toString().includes('%') ? '' : '%'})` : '';

        const epfAmt = calculateStatutoryAmount(epfRaw, basicSalary, true); 
        const eisAmt = calculateStatutoryAmount(eisRaw, basicSalary, true); 

        if (epfAmt > 0) document.getElementById('inpEPF').value = epfAmt.toFixed(2);
        if (eisAmt > 0) document.getElementById('inpEIS').value = eisAmt.toFixed(2);
    } else {
        document.getElementById('hintEPF').innerText = ''; document.getElementById('hintEIS').innerText = '';
    }
    window.calcTotals();
};

async function calculateAttendanceStats(uid, monthStr) {
    const staff = staffMap[uid];
    if (!staff) return;

    const [year, month] = monthStr.split('-');
    const startDate = `${monthStr}-01`;
    const endDate = `${monthStr}-${new Date(year, month, 0).getDate()}`;
    
    const targetIds = [String(uid)];
    if (staff.authUid) targetIds.push(String(staff.authUid));

    const [allSchedSnap, myLeavesSnap, myAttSnap] = await Promise.all([
        getDocs(query(collection(db, "schedules"), where("date", ">=", startDate), where("date", "<=", endDate))),
        getDocs(query(collection(db, "leaves"), where("uid", "in", targetIds), where("status", "==", "Approved"))),
        getDocs(query(collection(db, "attendance"), where("uid", "in", targetIds), where("date", ">=", startDate), where("date", "<=", endDate)))
    ]);

    const mySchedules = {}; let mySchedCount = 0;
    allSchedSnap.forEach(d => { const s = d.data(); if(targetIds.includes(s.userId)){ mySchedules[s.date] = s; mySchedCount++; } });

    const attMap = {};
    myAttSnap.forEach(d => {
        const a = d.data();
        if (a.verificationStatus === 'Verified') {
            if(!attMap[a.date]) attMap[a.date] = { in: null, out: null };
            if(a.session === 'Clock In') attMap[a.date].in = a.manualIn || a.timeIn || a.timestamp;
            if(a.session === 'Clock Out') attMap[a.date].out = a.manualOut || a.timeOut || a.timestamp;
        }
    });

    let actWorkedDays = 0, totalWorkMs = 0, totalLateMs = 0, lateCount = 0; 
    const satMulti = parseFloat(globalSettings.satMultiplier || 1.0);

    const toDateObj = (t, dateStr) => {
        if(!t) return null;
        if(t.toDate) return t.toDate();
        if(typeof t === 'string' && t.includes(':')) return new Date(`${dateStr}T${t}:00`);
        return new Date(t);
    };

    for (const [dateStr, records] of Object.entries(attMap)) {
        if (records.in) {
            const isSat = new Date(dateStr).getDay() === 6;
            actWorkedDays += isSat ? satMulti : 1;

            const sched = mySchedules[dateStr];
            if (sched && sched.start) {
                const inTime = toDateObj(records.in, dateStr);
                const schedStart = toDateObj(sched.start, dateStr);
                if (inTime > schedStart) { totalLateMs += (inTime - schedStart); lateCount++; }
                if (records.out) {
                    const outTime = toDateObj(records.out, dateStr);
                    let workMs = outTime - (inTime < schedStart ? schedStart : inTime);
                    workMs -= ((sched.breakMins || 60) * 60000); 
                    if(workMs > 0) totalWorkMs += workMs;
                }
            }
        }
    }

    let paidLeaveCount = 0;
    myLeavesSnap.forEach(d => {
        const l = d.data();
        let curr = new Date(l.startDate); let end = new Date(l.endDate);
        while(curr <= end) {
            const dStr = curr.toISOString().split('T')[0];
            if(dStr >= startDate && dStr <= endDate && l.type !== 'Unpaid Leave' && !attMap[dStr]?.in) paidLeaveCount++; 
            curr.setDate(curr.getDate() + 1);
        }
    });

    const totalDecimalHrs = (totalWorkMs / 3600000).toFixed(2);
    const formattedTotalHrs = msToHM(totalWorkMs);
    const totalLateMins = Math.floor(totalLateMs / 60000);

    const userSchedCounts = {}; 
    allSchedSnap.forEach(d => { userSchedCounts[d.data().userId] = (userSchedCounts[d.data().userId] || 0) + 1; });
    const dayFreq = {}; Object.values(userSchedCounts).forEach(c => dayFreq[c] = (dayFreq[c] || 0) + 1);
    let majorityDays = 26; let maxFreq = 0;
    for (let d in dayFreq) { if (dayFreq[d] > maxFreq) { maxFreq = dayFreq[d]; majorityDays = parseInt(d); } }

    document.getElementById('inpStdDays').value = majorityDays;
    document.getElementById('dispSchDays').innerHTML = `${mySchedCount} <span style="font-size:0.6rem">Days</span>`;
    document.getElementById('dispActDays').innerHTML = `${actWorkedDays} <span style="font-size:0.6rem">Days</span>`;
    document.getElementById('dispPaidLeave').innerHTML = `${paidLeaveCount} <span style="font-size:0.6rem">Days</span>`;
    document.getElementById('dispPayableDays').innerHTML = `${actWorkedDays + paidLeaveCount} <span style="font-size:0.6rem">Days</span>`;
    document.getElementById('dispTotalHrs').innerHTML = `${formattedTotalHrs}`;
    document.getElementById('dispLateStats').innerHTML = `${lateCount} <span style="font-size:0.6rem">times (${totalLateMins}m)</span>`;

    ['metaDaysSch', 'metaDaysAct', 'metaPaidLeave', 'metaTotalHrs', 'metaLateMins', 'metaLateCount'].forEach((id, i) => {
        document.getElementById(id).value = [mySchedCount, actWorkedDays, paidLeaveCount, totalDecimalHrs, totalLateMins, lateCount][i];
    });
}

window.calcTotals = (autoUpdateStatutory = false) => {
    const getVal = (id) => parseFloat(document.getElementById(id)?.value) || 0;
    const fullBasic = getVal('inpBasic');
    let grossBasic = 0, autoLateDeduct = 0;
    const lateMins = parseFloat(document.getElementById('metaLateMins').value) || 0;
    const lateCount = parseInt(document.getElementById('metaLateCount').value) || 0;

    if (globalSettings.calcMode === 'hourly') {
        grossBasic = getVal('inpHourlyRate') * (parseFloat(document.getElementById('metaTotalHrs').value) || 0);
        document.getElementById('prorationMsg').style.visibility = 'hidden';

        if (globalSettings.lateMode === 'times') {
            autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
            document.getElementById('lateFormulaText').innerText = `Fine: ${lateCount} times x RM${globalSettings.lateFixedAmount}`;
        } else document.getElementById('lateFormulaText').innerText = "Unpaid by default in Hourly mode.";
    } else {
        const stdDays = getVal('inpStdDays') || 26; 
        const totalPayableDays = (parseFloat(document.getElementById('metaDaysAct').value) || 0) + (parseFloat(document.getElementById('metaPaidLeave').value) || 0);
        const dailyRate = fullBasic / stdDays;
        grossBasic = Math.min(dailyRate * totalPayableDays, fullBasic);

        const msg = document.getElementById('prorationMsg');
        if (totalPayableDays < stdDays) { msg.style.visibility = 'visible'; msg.innerText = `Pro-rated: ${totalPayableDays} / ${stdDays} days`; } 
        else msg.style.visibility = 'hidden';

        if (globalSettings.lateMode === 'times') {
            autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
            document.getElementById('lateFormulaText').innerText = `Fine: ${lateCount} times x RM${globalSettings.lateFixedAmount}`;
        } else {
            autoLateDeduct = ((dailyRate / 8) / 60) * lateMins;
            document.getElementById('lateFormulaText').innerText = `Auto deduct: ${lateMins} mins`;
        }
    }
    
    document.getElementById('dispGrossBasic').value = formatMoney(grossBasic);
    if(!document.getElementById('inpLateDed').value && autoLateDeduct > 0) document.getElementById('inpLateDed').value = autoLateDeduct.toFixed(2);

    if (autoUpdateStatutory) {
        const uid = document.getElementById('staffSelect').value;
        const staff = staffMap[uid]; 
        
        if (staff && staff.statutory) {
            const epfRaw = staff.statutory.epf?.contrib || '';
            const eisRaw = staff.statutory.eis || '';

            document.getElementById('hintEPF').innerText = epfRaw ? `(${epfRaw}${epfRaw.toString().includes('%') ? '' : '%'})` : '';
            document.getElementById('hintEIS').innerText = eisRaw ? `(${eisRaw}${eisRaw.toString().includes('%') ? '' : '%'})` : '';

            const epfAmt = calculateStatutoryAmount(epfRaw, grossBasic, true); 
            const eisAmt = calculateStatutoryAmount(eisRaw, grossBasic, true); 

            if (epfAmt > 0) document.getElementById('inpEPF').value = epfAmt.toFixed(2);
            if (eisAmt > 0) document.getElementById('inpEIS').value = eisAmt.toFixed(2);
        } else {
            document.getElementById('hintEPF').innerText = ''; document.getElementById('hintEIS').innerText = '';
        }
    }

    const grossTotal = grossBasic + getVal('inpComm') + getVal('inpOT') + getVal('inpAllowance');
    const totalDed = getVal('inpEPF') + getVal('inpSOCSO') + getVal('inpEIS') + getVal('inpPCB') + getVal('inpLateDed') + getVal('inpAdvance'); 
    document.getElementById('dispNet').innerText = "RM " + formatMoney(grossTotal - totalDed);
};

// 🟢 SECURE: Save Payslip (Auto Overwrite via Deterministic ID + Logging)
window.savePayslipForm = async () => {
    const uid = document.getElementById('staffSelect').value;
    const month = document.getElementById('formMonthPicker').value;
    if(!uid || !month) return showStatusAlert('statusMessage', "Select staff and month", false); // 🟢

    showLoading(); // 🟢
    const staff = staffMap[uid];
    const getVal = (id) => parseFloat(document.getElementById(id).value) || 0;
    const status = document.getElementById('formStatus').value;
    
    const grossBasic = parseFloat(document.getElementById('dispGrossBasic').value.replace(/,/g,'')) || 0;
    const grossTotal = grossBasic + getVal('inpComm') + getVal('inpOT') + getVal('inpAllowance');
    const totalDed = getVal('inpEPF') + getVal('inpSOCSO') + getVal('inpEIS') + getVal('inpPCB') + getVal('inpLateDed') + getVal('inpAdvance');
    const net = grossTotal - totalDed;

    const payload = {
        uid, month,
        staffName: staff ? staff.displayName : 'Unknown',
        staffCode: staff ? staff.displayId : '',
        icNo: staff?.personal?.icNo || '-',
        epfNo: staff?.statutory?.epf?.no || '-',
        socsoNo: staff?.statutory?.socso?.no || '-',
        department: staff?.employment?.dept || '-',
        bankAcc: staff?.payroll?.bank1?.acc || '-',
        bankName: staff?.payroll?.bank1?.name || '-',
        basic: getVal('inpBasic'),
        final_basic: grossBasic, 
        earnings: { commission: getVal('inpComm'), ot: getVal('inpOT'), allowance: getVal('inpAllowance'), total: grossTotal },
        deductions: { epf: getVal('inpEPF'), socso: getVal('inpSOCSO'), eis: getVal('inpEIS'), tax: getVal('inpPCB'), late: getVal('inpLateDed'), advance: getVal('inpAdvance'), total: totalDed },
        employer_epf: getVal('inpEmpEPF'), employer_socso: getVal('inpEmpSOCSO'), employer_eis: getVal('inpEmpEIS'),
        attendanceStats: {
            stdDays: getVal('inpStdDays'), actDays: document.getElementById('metaDaysAct').value,
            paidLeave: document.getElementById('metaPaidLeave').value, totalHrs: document.getElementById('metaTotalHrs').value,
            lateMins: document.getElementById('metaLateMins').value, lateCount: document.getElementById('metaLateCount').value, 
            mode: globalSettings.calcMode
        },
        gross: grossTotal, net: net, status: status,
        updatedAt: serverTimestamp()
    };

    const payslipId = `${uid}_${month}`; 
    const oldDocId = document.getElementById('editDocId').value;

    try {
        const psRef = doc(db, "payslips", payslipId);
        const oldSnap = await getDoc(psRef);
        const isExisting = oldSnap.exists();
        const oldData = isExisting ? oldSnap.data() : null;

        if (isExisting && oldData.status === 'Published' && status === 'Published' && oldDocId !== payslipId) {
            if(!confirm(`⚠️ OVERWRITE WARNING\n\nA Published payslip already exists for ${staff.displayName} in ${month}.\nSaving will automatically OVERWRITE the old one. Proceed?`)) {
                hideLoading();
                return;
            }
        }

        let actionType = isExisting ? "OVERWRITE_PAYSLIP" : "CREATE_PAYSLIP";
        if (oldDocId === payslipId) actionType = "EDIT_PAYSLIP";

        payload.createdAt = isExisting ? oldData.createdAt : serverTimestamp();

        if (oldDocId && oldDocId !== payslipId) {
            await deleteDoc(doc(db, "payslips", oldDocId));
            actionType = "MIGRATE_AND_OVERWRITE_PAYSLIP";
        }

        await setDoc(psRef, payload);

        // Advance deduction
        if (status === 'Published' && getVal('inpAdvance') > 0) {
            const rawIds = document.getElementById('pendingAdvanceIds').value;
            if (rawIds) {
                const advIds = JSON.parse(rawIds);
                const batch = writeBatch(db);
                advIds.forEach(advId => {
                    batch.update(doc(db, "salary_advances", advId), { isDeducted: true, deductedInMonth: month, deductedAt: serverTimestamp() });
                });
                await batch.commit();
            }
        }

        await logAdminAction(db, auth.currentUser, actionType, uid, oldData, payload);

        formModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', 'Payslip saved successfully.', true); // 🟢
        window.loadPayroll();
    } catch(e) { 
        hideLoading();
        showStatusAlert('statusMessage', "Save error: " + e.message, false); 
    }
};

window.loadPayroll = async () => {
    const month = document.getElementById('globalMonthPicker').value;
    if(!month) return;
    showLoading(); // 🟢
    const listDiv = document.getElementById('payrollList');
    listDiv.innerHTML = '';
    
    try {
        const q = query(collection(db, "payslips"), where("month", "==", month));
        const snap = await getDocs(q);
        currentPayrollData = [];
        let totalNet = 0; let totalEmpEPF = 0;

        if (snap.empty) {
            listDiv.innerHTML = `<div class="text-center py-5 text-muted fw-bold">No payslips found for ${month}.</div>`;
            document.getElementById('statTotal').innerText = "RM 0.00"; document.getElementById('statEPF').innerText = "RM 0.00";
            return; 
        }

        snap.forEach(doc => {
            const d = doc.data(); d.id = doc.id;
            currentPayrollData.push(d);
            totalNet += (d.net || 0); totalEmpEPF += (d.employer_epf || 0);

            const displayName = staffMap[d.uid] ? staffMap[d.uid].displayName : d.staffName;
            const modeText = d.attendanceStats?.mode === 'hourly' ? '⌚ Hourly' : '📅 Daily';
            
            // 替换 window.loadPayroll 里面的这一段:
            const row = document.createElement('div');
            row.className = `row align-items-center py-3 border-bottom px-3 bg-white status-${d.status} hover-bg-light`;
            row.innerHTML = `
                <div class="col-3">
                    <div class="fw-bold text-primary" style="cursor:pointer" onclick="window.openEditModal('${d.id}')">${displayName}</div>
                    <small class="text-muted">${modeText}</small>
                </div>
                <div class="col-2 text-primary fw-bold">RM ${formatMoney(d.final_basic || d.basic)}</div>
                <div class="col-2 text-danger">RM ${formatMoney(d.deductions?.total || 0)}</div>
                <div class="col-2 fw-bold fs-5">RM ${formatMoney(d.net)}</div>
                <div class="col-1"><span class="badge ${d.status === 'Published' ? 'bg-success' : 'bg-warning text-dark'} px-2 py-1">${d.status}</span></div>
                <div class="col-2 text-end">
                    <button class="btn btn-sm btn-light border me-1" onclick="window.openEditModal('${d.id}')" title="Edit"><i data-lucide="edit-2" class="size-4"></i></button>
                    <button class="btn btn-sm btn-outline-dark me-1" onclick="window.viewPayslip('${d.id}')" title="Print/View"><i data-lucide="printer" class="size-4"></i></button>
                    <button class="btn btn-sm btn-outline-danger" onclick="window.deletePayslip('${d.id}')" title="Delete"><i data-lucide="trash-2" class="size-4"></i></button>
                </div>
            `;
            listDiv.appendChild(row);
        });

        document.getElementById('statTotal').innerText = "RM " + formatMoney(totalNet);
        document.getElementById('statEPF').innerText = "RM " + formatMoney(totalEmpEPF);
        lucide.createIcons();
    } catch (e) { 
        console.error(e); 
    } 
    finally { 
        hideLoading(); 
    }
};
// 🟢 SECURE: Delete Payslip (With multiple confirmations for Published items)
window.deletePayslip = async (id) => {
    const d = currentPayrollData.find(x => x.id === id);
    if (!d) return;

    // 1. 验证与多重确认机制
    if (d.status === 'Published') {
        const confirm1 = confirm(`⚠️ WARNING: This payslip for ${d.staffName} is already PUBLISHED.\nDeleting it will remove the official record and revert any deducted advances.\n\nAre you sure you want to proceed?`);
        if (!confirm1) return;
        
        const confirm2 = prompt(`To confirm deletion of this PUBLISHED payslip, please type the word "DELETE" below:`);
        if (confirm2 !== "DELETE") {
            alert("Action cancelled. You did not type 'DELETE'.");
            return;
        }
    } else {
        // 对于 Draft 状态，只需要普通的确认
        if (!confirm(`Are you sure you want to delete the draft payslip for ${d.staffName}?`)) return;
    }

    showLoading(); // 🟢

    try {
        // 2. 如果是已发布的工资单且包含预支扣款 (Advance)，需要将预支记录退回到 "未扣除" 状态
        if (d.status === 'Published' && d.deductions?.advance > 0) {
            const targetIds = [d.uid];
            if (staffMap[d.uid]?.authUid) targetIds.push(staffMap[d.uid].authUid);
            
            // 找出这个月被扣除的 advance
            const advSnap = await getDocs(query(collection(db, "salary_advances"), 
                where("uid", "in", targetIds), 
                where("deductedInMonth", "==", d.month)
            ));
            
            if (!advSnap.empty) {
                const batch = writeBatch(db);
                advSnap.forEach(advDoc => {
                    batch.update(advDoc.ref, { 
                        isDeducted: false, 
                        deductedInMonth: null, 
                        deductedAt: null,
                        updatedAt: serverTimestamp()
                    });
                });
                await batch.commit();
            }
        }

        // 3. 删除 Payslip 记录
        await deleteDoc(doc(db, "payslips", id));

        // 4. 记录管理员操作日志
        await logAdminAction(db, auth.currentUser, "DELETE_PAYSLIP", d.uid, d, null);

        hideLoading();
        showStatusAlert('statusMessage', 'Payslip deleted successfully.', true); // 🟢
        
        // 重新加载列表
        window.loadPayroll();

    } catch (e) {
        hideLoading();
        console.error("Delete Error:", e);
        showStatusAlert('statusMessage', "Delete Failed: " + e.message, false);
    }
};
window.openCreateModal = () => {
    document.getElementById('payslipForm').reset();
    document.getElementById('editDocId').value = "";
    document.getElementById('pendingAdvanceIds').value = "";
    document.getElementById('formModalTitle').innerText = "Create New Payslip";
    document.getElementById('staffSelect').disabled = false;
    document.getElementById('formMonthPicker').disabled = false;
    
    document.getElementById('dispNet').innerText = "RM 0.00";
    document.getElementById('dispGrossBasic').value = "0.00";
    document.getElementById('hintEPF').innerText = "";
    document.getElementById('hintEIS').innerText = "";
    
    const globalDate = document.getElementById('globalMonthPicker').value;
    if(globalDate) document.getElementById('formMonthPicker').value = globalDate;

    window.toggleSettingsView(); 
    formModal.show();
};

window.openEditModal = (id) => {
    const d = currentPayrollData.find(x => x.id === id);
    if(!d) return;

    document.getElementById('editDocId').value = id;
    document.getElementById('formModalTitle').innerText = "Edit Payslip - " + d.staffName;
    
    document.getElementById('staffSelect').value = d.uid;
    document.getElementById('staffSelect').disabled = true; 
    document.getElementById('formMonthPicker').value = d.month;
    document.getElementById('formMonthPicker').disabled = true; 

    document.getElementById('inpBasic').value = d.basic; 
    document.getElementById('inpComm').value = d.earnings.commission || 0;
    document.getElementById('inpOT').value = d.earnings.ot || 0;
    document.getElementById('inpAllowance').value = d.earnings.allowance || 0;

    document.getElementById('inpEPF').value = d.deductions.epf || 0;
    document.getElementById('inpSOCSO').value = d.deductions.socso || 0;
    document.getElementById('inpEIS').value = d.deductions.eis || 0;
    document.getElementById('inpPCB').value = d.deductions.tax || 0;
    document.getElementById('inpLateDed').value = d.deductions.late || 0;
    document.getElementById('inpAdvance').value = d.deductions.advance || 0; 

    document.getElementById('inpEmpEPF').value = d.employer_epf || 0;
    document.getElementById('inpEmpSOCSO').value = d.employer_socso || 0;
    document.getElementById('inpEmpEIS').value = d.employer_eis || 0;

    document.getElementById('formStatus').value = d.status || 'Draft';
    
    const staff = staffMap[d.uid];
    if (staff && staff.statutory) {
        const epfRaw = staff.statutory.epf?.contrib || '';
        const eisRaw = staff.statutory.eis || '';
        document.getElementById('hintEPF').innerText = epfRaw ? `(${epfRaw}${epfRaw.toString().includes('%') ? '' : '%'})` : '';
        document.getElementById('hintEIS').innerText = eisRaw ? `(${eisRaw}${eisRaw.toString().includes('%') ? '' : '%'})` : '';
    }
    
    if (d.attendanceStats) {
        document.getElementById('inpStdDays').value = d.attendanceStats.stdDays || 26;
        document.getElementById('metaDaysAct').value = d.attendanceStats.actDays || 0;
        document.getElementById('metaPaidLeave').value = d.attendanceStats.paidLeave || 0;
        document.getElementById('metaTotalHrs').value = d.attendanceStats.totalHrs || 0; 
        document.getElementById('metaLateMins').value = d.attendanceStats.lateMins || 0;
        document.getElementById('metaLateCount').value = d.attendanceStats.lateCount || 0;
        
        document.getElementById('dispActDays').innerHTML = `${d.attendanceStats.actDays} <span style="font-size:0.6rem">Days</span>`;
        document.getElementById('dispPaidLeave').innerHTML = `${d.attendanceStats.paidLeave} <span style="font-size:0.6rem">Days</span>`;
        document.getElementById('dispPayableDays').innerHTML = `${parseFloat(d.attendanceStats.actDays) + parseFloat(d.attendanceStats.paidLeave)} <span style="font-size:0.6rem">Days</span>`;
        
        const savedTotalHrs = parseFloat(d.attendanceStats.totalHrs) || 0;
        const hrPart = Math.floor(savedTotalHrs);
        const minPart = Math.round((savedTotalHrs - hrPart) * 60);
        document.getElementById('dispTotalHrs').innerHTML = `${hrPart}h ${minPart}m`;
        
        document.getElementById('dispLateStats').innerHTML = `${d.attendanceStats.lateCount || 0} <span style="font-size:0.6rem">times (${d.attendanceStats.lateMins || 0}m)</span>`;
        
        window.calcTotals(false);
    }
    formModal.show();
};

window.viewPayslip = (id) => {
    const d = currentPayrollData.find(x => x.id === id);
    if(!d) return;
    const usedBasic = d.final_basic || d.basic; 

    let extraEarnRows = "", extraDedRows = "";
    if(d.earnings.commission > 0) extraEarnRows += `<tr><td>COMMISSION</td><td style="text-align: right;">${formatMoney(d.earnings.commission)}</td><td></td><td></td></tr>`;
    if(d.earnings.ot > 0) extraEarnRows += `<tr><td>OVERTIME</td><td style="text-align: right;">${formatMoney(d.earnings.ot)}</td><td></td><td></td></tr>`;
    if(d.earnings.allowance > 0) extraEarnRows += `<tr><td>ALLOWANCE</td><td style="text-align: right;">${formatMoney(d.earnings.allowance)}</td><td></td><td></td></tr>`;

    if(d.deductions.eis > 0) extraDedRows += `<tr><td></td><td></td><td style="padding-left: 20px;">EIS (Employee)</td><td style="text-align: right;">${formatMoney(d.deductions.eis)}</td></tr>`;
    if(d.deductions.tax > 0) extraDedRows += `<tr><td></td><td></td><td style="padding-left: 20px;">PCB / TAX</td><td style="text-align: right;">${formatMoney(d.deductions.tax)}</td></tr>`;
    if(d.deductions.late > 0) extraDedRows += `<tr><td></td><td></td><td style="padding-left: 20px; color:red;">LATE DEDUCTION</td><td style="text-align: right; color:red;">${formatMoney(d.deductions.late)}</td></tr>`;
    if(d.deductions.advance > 0) extraDedRows += `<tr><td></td><td></td><td style="padding-left: 20px; color:red;">SALARY ADVANCE</td><td style="text-align: right; color:red;">${formatMoney(d.deductions.advance)}</td></tr>`;

    // 获取当前打印日期
    const today = new Date();
    const printDate = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;
    const stats = d.attendanceStats || { actDays:0, schDays:0, paidLeave:0 };

    const html = `
        <div class="payslip-preview bg-white shadow-sm border rounded">
            <div class="payslip-header border-bottom border-dark pb-3 mb-3">
                <div class="company-name fs-4">RH RIDER HUB MOTOR (M) SDN. BHD.</div>
                <div class="company-address text-secondary mt-1">NO.26&28, JALAN MERU IMPIAN B3, CASA KAYANGAN @ PUSAT PERNIAGAAN MERU IMPIAN,<br>BANDAR MERU RAYA, 30020 IPOH, Perak</div>
            </div>

            <div class="info-grid bg-light p-3 rounded mb-3 border">
                <div>
                    <div class="info-row"><span>Employee Name</span> <span class="fw-bold">: ${d.staffName}</span></div>
                    <div class="info-row"><span>Department</span> <span>: ${d.department}</span></div>
                    <div class="info-row"><span>Employee Code</span> <span>: ${d.staffCode}</span></div>
                    <div class="info-row mt-1 pt-1 border-top border-secondary border-opacity-25"><span>Bank Acc</span> <span class="fw-bold">: ${d.bankAcc || '-'} (${d.bankName || '-'})</span></div>
                </div>
                <div>
                    <div class="info-row"><span>IC Number</span> <span>: ${d.icNo}</span></div>
                    <div class="info-row"><span>EPF Number</span> <span>: ${d.epfNo}</span></div>
                    <div class="info-row"><span>SOCSO Number</span> <span>: ${d.socsoNo}</span></div>
<div class="info-row mt-1 pt-1 border-top border-secondary border-opacity-25 text-primary fw-bold"><span>Print Date</span> <span>: ${printDate}</span></div>                </div>
            </div>

            <table class="finance-table">
                <thead class="bg-light">
                    <tr><th style="width:35%">EARNINGS</th><th style="text-align:right">AMOUNT</th><th style="width:35%; padding-left:20px;">DEDUCTIONS</th><th style="text-align:right">AMOUNT</th></tr>
                </thead>
                <tbody>
                    <tr>
                        <td>BASIC PAY</td><td style="text-align:right">${formatMoney(usedBasic)}</td>
                        <td style="padding-left:20px;">EPF (Employee)</td><td style="text-align:right">${formatMoney(d.deductions.epf)}</td>
                    </tr>
                    <tr>
                        <td></td><td></td>
                        <td style="padding-left:20px;">SOCSO (Employee)</td><td style="text-align:right">${formatMoney(d.deductions.socso)}</td>
                    </tr>
                    ${extraEarnRows}
                    ${extraDedRows}
                    <tr class="border-top border-dark">
                        <td style="font-weight:bold; padding-top:10px;">Total Earnings</td><td style="text-align:right; font-weight:bold; padding-top:10px; color:#2563eb;">${formatMoney(d.gross)}</td>
                        <td style="padding-left:20px; font-weight:bold; padding-top:10px;">Total Deductions</td><td style="text-align:right; font-weight:bold; padding-top:10px; color:#dc2626;">${formatMoney(d.deductions.total)}</td>
                    </tr>
                </tbody>
            </table>

            <div class="total-section d-flex justify-content-between align-items-center mt-4 bg-light p-3 rounded border">
                <div class="small text-muted">
                    <div>Employer EPF: <b>RM ${formatMoney(d.employer_epf)}</b></div>
                    <div>Employer SOCSO: <b>RM ${formatMoney(d.employer_socso)}</b></div>
                </div>
                <div class="text-end">
                    <div class="text-muted text-uppercase fw-bold" style="font-size:0.7rem; letter-spacing:1px;">Net Pay</div>
                    <div class="text-dark" style="font-size:1.6rem; font-weight:900;">RM ${formatMoney(d.net)}</div>
                </div>
            </div>
            
            <div style="margin-top:20px; font-size:0.75rem; border:1px dashed #ccc; padding:10px; border-radius:6px; color:#64748b;">
                <b>Attendance Stats:</b> Payable Days: ${parseFloat(stats.actDays) + parseFloat(stats.paidLeave)} / ${stats.stdDays} (Worked: ${stats.actDays}, Leave: ${stats.paidLeave})
                <br><b>Late Stats:</b> ${stats.lateCount || 0} times (${stats.lateMins || 0} minutes)
            </div>
        </div>
    `;
    document.getElementById('printArea').innerHTML = html;
    printModal.show();
};

// 🟢 SECURE: Publish All
window.publishAll = async () => {
    const drafts = currentPayrollData.filter(d => d.status === 'Draft');
    if(drafts.length === 0) return showStatusAlert('statusMessage', "No draft payslips found to publish.", false); // 🟢
    
    if(!confirm(`Are you sure you want to officially publish ${drafts.length} payslip(s)?\n\nThis will make them visible to staff and PERMANENTLY deduct their approved Salary Advances.`)) return;
    
    showLoading(); // 🟢
    const month = document.getElementById('globalMonthPicker').value;

    try {
        await runTransaction(db, async (transaction) => {
            const advanceRefsToUpdate = [];
            for (const d of drafts) {
                if (d.deductions?.advance > 0) {
                    const targetIds = [d.uid];
                    if(staffMap[d.uid]?.authUid) targetIds.push(staffMap[d.uid].authUid);
                    
                    const advSnap = await getDocs(query(collection(db, "salary_advances"), where("uid", "in", targetIds), where("status", "==", "Approved")));
                    advSnap.forEach(advDoc => {
                        if (!advDoc.data().isDeducted) {
                            advanceRefsToUpdate.push(advDoc.ref);
                        }
                    });
                }
            }

            drafts.forEach(d => {
                const psRef = doc(db, "payslips", d.id);
                transaction.update(psRef, { status: 'Published', publishedAt: serverTimestamp() });
            });

            advanceRefsToUpdate.forEach(ref => {
                transaction.update(ref, { isDeducted: true, deductedInMonth: month, deductedAt: serverTimestamp() });
            });
        });

        await logAdminAction(db, auth.currentUser, "BULK_PUBLISH_PAYSLIPS", "MULTIPLE", null, { count: drafts.length, month: month });

        hideLoading();
        showStatusAlert('statusMessage', `Successfully published ${drafts.length} payslips!`, true); // 🟢
        window.loadPayroll();

    } catch (e) { 
        hideLoading();
        console.error(e);
        showStatusAlert('statusMessage', "Publish Failed: " + e.message, false); 
    } 
};