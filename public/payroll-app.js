import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, doc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, getDoc, onSnapshot, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { formatMoney, formatTime, calculateStatutoryAmount, msToHM, logAdminAction, showLoading, hideLoading, showStatusAlert } from './utils.js';
import { requireAdmin } from './auth-guard.js';

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
let holidaysMap = {}; // 🟢 缓存 Public Holidays
let formModal, printModal, advancesModal, settingsModal;
let globalSettings = { calcMode: 'daily', satMultiplier: 1.0, lateMode: 'minutes', lateFixedAmount: 10 }; 

// ==========================================
// INITIALIZATION
// ==========================================
requireAdmin(app, db, async (user) => {
    try {
        showLoading(); 
        
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
        showStatusAlert('statusMessage', 'Failed to initialize Payroll system.', false); 
    } finally {
        hideLoading(); 
        lucide.createIcons();
    }
});

// ==========================================
// 1. SETTINGS & HOLIDAYS
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

        // 🟢 加载 Public Holidays
        const holSnap = await getDoc(doc(db, "settings", "holidays"));
        if (holSnap.exists() && holSnap.data().holiday_list) {
            holSnap.data().holiday_list.forEach(h => { holidaysMap[h.date] = h.name; });
        }
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
    
    showLoading();
    try {
        const oldSnap = await getDoc(doc(db, "settings", "payroll_config"));
        await setDoc(doc(db, "settings", "payroll_config"), newConfig, { merge: true });
        
        await logAdminAction(db, auth.currentUser, "UPDATE_PAYROLL_SETTINGS", "GLOBAL", oldSnap.exists() ? oldSnap.data() : null, newConfig);

        globalSettings = { ...globalSettings, ...newConfig };
        settingsModal.hide();
        hideLoading();
        showStatusAlert('statusMessage', "Settings Saved! Please re-save Drafts.", true); 
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
    document.getElementById('advanceModalAlert').classList.add('d-none');
    advancesModal.show();

    try {
        const snap = await getDocs(query(collection(db, "salary_advances")));
        let html = ""; let count = 0;

        snap.forEach(d => {
            const data = d.data();
            if(data.isDeducted || data.status === 'Rejected') return; 

            count++;
            let actionHtml = "";
            let statusBadge = "";

            if (data.status === 'Pending') {
                statusBadge = `<span class="badge bg-warning text-dark px-2 py-1">Pending</span>`;
                actionHtml = `
                    <button class="btn btn-sm btn-success fw-bold px-3 py-1 me-1 shadow-sm" onclick="window.updateAdvanceStatus('${d.id}', 'Approved')">Approve</button>
                    <button class="btn btn-sm btn-outline-danger fw-bold px-3 py-1" onclick="window.updateAdvanceStatus('${d.id}', 'Rejected')">Reject</button>
                `;
            } else if (data.status === 'Approved') {
                if (data.isTransferred) {
                    statusBadge = `<span class="badge bg-success px-2 py-1"><i data-lucide="check-double" class="size-3 me-1"></i> Transferred</span>`;
                    actionHtml = `<span class="text-success small fw-bold"><i data-lucide="check-circle" class="size-3"></i> Ready for Deduction</span>`;
                } else {
                    statusBadge = `<span class="badge bg-info text-dark px-2 py-1"><i data-lucide="clock" class="size-3 me-1"></i> Awaiting Transfer</span>`;
                    actionHtml = `
                        <button class="btn btn-sm btn-primary fw-bold px-3 py-1 me-1 shadow-sm" onclick="window.markAdvanceTransferred('${d.id}')">Mark Transferred</button>
                        <button class="btn btn-sm btn-light border text-danger py-1" onclick="window.updateAdvanceStatus('${d.id}', 'Rejected')">Revoke</button>
                    `;
                }
            }

            html += `
                <tr class="align-middle">
                    <td class="ps-4"><div class="fw-bold text-dark">${data.empName || '-'}</div><small class="text-muted">${data.empCode || ''}</small></td>
                    <td class="text-danger fw-bold fs-6">RM ${formatMoney(data.amount)}</td>
                    <td class="text-secondary" style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${data.reason || '-'}">${data.reason || '-'}</td>
                    <td>${statusBadge}</td>
                    <td class="text-end pe-4">${actionHtml}</td>
                </tr>
            `;
        });
        
        listDiv.innerHTML = count > 0 ? html : '<tr><td colspan="5" class="text-center py-5 text-muted fw-bold">No pending/active requests found.</td></tr>';
        lucide.createIcons();
    } catch (e) { console.error(e); }
};

window.updateAdvanceStatus = async (id, status) => {
    showLoading(); 
    try {
        const docRef = doc(db, "salary_advances", id);
        const oldSnap = await getDoc(docRef);
        const oldData = oldSnap.data();

        await updateDoc(docRef, { status: status, updatedAt: serverTimestamp() });
        
        await logAdminAction(db, auth.currentUser, "APPROVE_ADVANCE", oldData.uid, { status: oldData.status }, { status: status, amount: oldData.amount });

        hideLoading();
        showModalAlert(`Request successfully marked as ${status}.`, 'success');
        window.openAdvancesModal(); 
    } catch (e) { 
        hideLoading();
        showModalAlert("Error: " + e.message, 'danger'); 
    }
};

window.markAdvanceTransferred = async (id) => {
    if(!confirm("Are you sure you have transferred the funds to the employee's bank account?\n\nOnce marked as transferred, it will be automatically deducted from their next payslip.")) return;
    
    showLoading();
    try {
        const docRef = doc(db, "salary_advances", id);
        await updateDoc(docRef, { 
            isTransferred: true, 
            transferredAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        
        hideLoading();
        showModalAlert('Funds marked as transferred successfully!', 'success');
        window.openAdvancesModal(); 
    } catch (e) {
        hideLoading();
        showModalAlert("Error: " + e.message, 'danger'); 
    }
};

function showModalAlert(msg, type) {
    const alertBox = document.getElementById('advanceModalAlert');
    alertBox.className = `alert alert-${type} m-3 small fw-bold text-center`;
    alertBox.innerText = msg;
    alertBox.classList.remove('d-none');
    setTimeout(() => { alertBox.classList.add('d-none'); }, 4000);
}

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
        if (s.status === 'disabled' || s.role === 'manager') return;
        
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
            
            const advSnap = await getDocs(query(collection(db, "salary_advances"), where("uid", "in", targetIds), where("status", "==", "Approved"), where("isDeducted", "==", false)));
            advSnap.forEach(d => {
                const adv = d.data();
                if (adv.isTransferred === true) {
                    totalAdv += adv.amount; 
                    advIds.push(d.id); 
                }
            });
        } catch (e) { console.error("Error fetching advances", e); }
    }

    if(staff) {
        document.getElementById('inpBasic').value = staff.payroll?.basic || 0;
        document.getElementById('inpAdvance').value = totalAdv;
        document.getElementById('pendingAdvanceIds').value = JSON.stringify(advIds);
        window.recalcStatutoryAndTotals(); 
    }

    showLoading(); 
    await calculateAttendanceStats(uid, monthStr);
    window.calcTotals(true); 
    hideLoading(); 
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
    const daysInMonth = new Date(year, month, 0).getDate();
    const endDate = `${monthStr}-${daysInMonth}`;
    
    const targetIds = [String(uid)];
    if (staff.authUid) targetIds.push(String(staff.authUid));

    const [allSchedSnap, myLeavesSnap, myAttSnap] = await Promise.all([
        getDocs(query(collection(db, "schedules"), where("date", ">=", startDate), where("date", "<=", endDate))),
        getDocs(query(collection(db, "leaves"), where("uid", "in", targetIds), where("status", "==", "Approved"))),
        getDocs(query(collection(db, "attendance"), where("uid", "in", targetIds), where("date", ">=", startDate), where("date", "<=", endDate)))
    ]);

    const mySchedules = {}; let mySchedCount = 0;
    const userSchedCounts = {}; 
    const userSchedHours = {}; 

    allSchedSnap.forEach(d => { 
        const s = d.data(); 
        if(targetIds.includes(s.userId)){ 
            mySchedules[s.date] = s; 
            mySchedCount++; 
        } 
        userSchedCounts[s.userId] = (userSchedCounts[s.userId] || 0) + 1; 
        
        if(s.start && s.end) {
            const start = s.start.toDate ? s.start.toDate() : new Date(s.start);
            const end = s.end.toDate ? s.end.toDate() : new Date(s.end);
            let duration = (end - start) / 3600000;
            duration -= (s.breakMins || 0) / 60;
            if (duration > 0) userSchedHours[s.userId] = (userSchedHours[s.userId] || 0) + duration;
        }
    });

    const attMap = {};
    myAttSnap.forEach(d => {
        const a = d.data();
        if (a.verificationStatus === 'Verified') {
            if(!attMap[a.date]) attMap[a.date] = { in: null, out: null, breakOut: null, breakIn: null };
            if(a.session === 'Clock In') attMap[a.date].in = a.manualIn || a.timeIn || a.timestamp;
            if(a.session === 'Clock Out') attMap[a.date].out = a.manualOut || a.timeOut || a.timestamp;
            if(a.session === 'Break Out') attMap[a.date].breakOut = a.manualOut || a.timeOut || a.timestamp;
            if(a.session === 'Break In') attMap[a.date].breakIn = a.manualIn || a.timeIn || a.timestamp;
        }
    });

    // 🟢 加载所有请假记录
    const userLeaves = {};
    myLeavesSnap.forEach(d => {
        const l = d.data();
        const [sY, sM, sD] = l.startDate.split('-');
        const [eY, eM, eD] = l.endDate.split('-');
        let curr = new Date(sY, sM - 1, sD);
        const endD = new Date(eY, eM - 1, eD);

        while(curr <= endD) {
            const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
            if (dStr >= startDate && dStr <= endDate) {
                userLeaves[dStr] = l.type;
            }
            curr.setDate(curr.getDate() + 1);
        }
    });

    let actWorkedDays = 0, totalWorkMs = 0, totalLateMs = 0, lateCount = 0; 
    let phUnworkedDays = 0, phWorkedDays = 0, phWorkedMs = 0;
    const satMulti = parseFloat(globalSettings.satMultiplier || 1.0);

    const toDateObj = (t, dateStr) => {
        if(!t) return null;
        if(t.toDate) return t.toDate();
        if(typeof t === 'string' && t.includes(':')) return new Date(`${dateStr}T${t}:00`);
        return new Date(t);
    };

    // 🟢 核心按天计算逻辑
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${month}-${String(d).padStart(2, '0')}`;
        const records = attMap[dateStr];
        const sched = mySchedules[dateStr];
        const isScheduled = !!sched;
        const isPH = !!holidaysMap[dateStr];
        const validPH = isPH && isScheduled; // 必须有排班的假期才算数

        if (records && records.in) {
            // 当天有打卡记录 -> 计算为已工作
            const isSat = new Date(dateStr).getDay() === 6;
            actWorkedDays += isSat ? satMulti : 1;

            if (sched && sched.start) {
                const inTime = toDateObj(records.in, dateStr);
                const schedStart = toDateObj(sched.start, dateStr);
                if (inTime > schedStart) { totalLateMs += (inTime - schedStart); lateCount++; }
            }

            let workMsThisDay = 0;
            if (records.out) {
                const inTime = toDateObj(records.in, dateStr);
                const outTime = toDateObj(records.out, dateStr);
                workMsThisDay = outTime - inTime;
                
                if (records.breakOut && records.breakIn) {
                    const bOut = toDateObj(records.breakOut, dateStr);
                    const bIn = toDateObj(records.breakIn, dateStr);
                    const breakDur = bIn - bOut;
                    if (breakDur > 0) workMsThisDay -= breakDur;
                }

                // 🟢 封顶逻辑 (Capping to Scheduled Hours)
                if (sched && sched.start && sched.end) {
                    const sStart = toDateObj(sched.start, dateStr);
                    const sEnd = toDateObj(sched.end, dateStr);
                    let schedDurMs = sEnd - sStart;
                    if (sched.breakMins) schedDurMs -= sched.breakMins * 60000;

                    // 如果实际打卡工作时间大于排班标准时间，则强制截断为排班时间
                    if (schedDurMs > 0 && workMsThisDay > schedDurMs) {
                        workMsThisDay = schedDurMs;
                    }
                }

                if(workMsThisDay > 0) totalWorkMs += workMsThisDay;
            }

            if (validPH) {
                phWorkedDays++;
                phWorkedMs += (workMsThisDay > 0 ? workMsThisDay : 0);
            }
        } else {
            // 当天没打卡 -> 检查是否有公共假期优先
            if (validPH) {
                phUnworkedDays++; // 有排班的假期且没打卡，算 Paid PH Off，忽略任何其他 Leave 申请
            }
        }
    }

    let annualLeaveCount = 0, medicalLeaveCount = 0, unpaidLeaveCount = 0;

    myLeavesSnap.forEach(d => {
        const l = d.data();
        const [sY, sM, sD] = l.startDate.split('-');
        const [eY, eM, eD] = l.endDate.split('-');
        let curr = new Date(sY, sM - 1, sD);
        const endD = new Date(eY, eM - 1, eD);

        while(curr <= endD) {
            const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
            // 🟢 如果当天是没有打卡的请假，且不是有效的公共假期，则累加请假天数
            const validPH = !!holidaysMap[dStr] && !!mySchedules[dStr];
            if(dStr >= startDate && dStr <= endDate && !attMap[dStr]?.in && !validPH) {
                if (l.type === 'Annual Leave' || l.type === '年假' || l.type === 'Cuti Tahunan') annualLeaveCount++;
                else if (l.type === 'Medical Leave' || l.type === '病假' || l.type === 'Cuti Sakit') medicalLeaveCount++;
                else unpaidLeaveCount++; 
            }
            curr.setDate(curr.getDate() + 1);
        }
    });

    const totalDecimalHrs = (totalWorkMs / 3600000).toFixed(2);
    const formattedTotalHrs = msToHM(totalWorkMs);
    const totalLateMins = Math.floor(totalLateMs / 60000);

    const dayFreq = {}; Object.values(userSchedCounts).forEach(c => dayFreq[c] = (dayFreq[c] || 0) + 1);
    let majorityDays = 26; let maxFreq = 0;
    for (let d in dayFreq) { if (dayFreq[d] > maxFreq) { maxFreq = dayFreq[d]; majorityDays = parseInt(d); } }

    const hrFreq = {}; 
    Object.values(userSchedHours).forEach(h => {
        const key = h.toFixed(1);
        hrFreq[key] = (hrFreq[key] || 0) + 1;
    });

    let majorityHours = 208; let maxHrFreq = 0;
    for (let h in hrFreq) { 
        if (hrFreq[h] > maxHrFreq) { 
            maxHrFreq = hrFreq[h]; 
            majorityHours = parseFloat(h); 
        } 
    }

    const paidLeaveCount = annualLeaveCount + medicalLeaveCount; 

    document.getElementById('metaTotalHrs').dataset.majorityHours = majorityHours;
    document.getElementById('inpStdDays').value = majorityDays;
    document.getElementById('dispSchDays').innerHTML = `${mySchedCount} <span style="font-size:0.6rem">Days</span>`;
    document.getElementById('dispActDays').innerHTML = `${actWorkedDays} <span style="font-size:0.6rem">Days</span>`;
    
    document.getElementById('dispPaidLeave').innerHTML = `${paidLeaveCount} <span style="font-size:0.6rem">Days (AL:${annualLeaveCount} ML:${medicalLeaveCount})</span>`;
    
    // PH Dashboard Stats
    document.getElementById('dispPH').innerHTML = `${phUnworkedDays} / ${phWorkedDays} <span style="font-size:0.6rem">Off/Work</span>`;
    
    document.getElementById('dispPayableDays').innerHTML = `${actWorkedDays + paidLeaveCount + phUnworkedDays} <span style="font-size:0.6rem">Days</span>`;
    
    document.getElementById('dispTotalHrs').innerHTML = `${formattedTotalHrs}`;
    document.getElementById('dispLateStats').innerHTML = `${lateCount} <span style="font-size:0.6rem">times (${totalLateMins}m)</span>`;

    ['metaDaysSch', 'metaDaysAct', 'metaTotalHrs', 'metaLateMins', 'metaLateCount'].forEach((id, i) => {
        document.getElementById(id).value = [mySchedCount, actWorkedDays, totalDecimalHrs, totalLateMins, lateCount][i];
    });

    document.getElementById('metaAnnualLeave').value = annualLeaveCount;
    document.getElementById('metaMedicalLeave').value = medicalLeaveCount;
    document.getElementById('metaUnpaidLeave').value = unpaidLeaveCount;

    document.getElementById('metaPHUnworked').value = phUnworkedDays;
    document.getElementById('metaPHWorked').value = phWorkedDays;
    document.getElementById('metaPHWorkedHrs').value = (phWorkedMs / 3600000).toFixed(2);
}

window.calcTotals = (autoUpdateStatutory = false) => {
    const getVal = (id) => parseFloat(document.getElementById(id)?.value) || 0;
    const fullBasic = getVal('inpBasic');
    let baseGross = 0, phExtraGross = 0, autoLateDeduct = 0;
    const lateMins = parseFloat(document.getElementById('metaLateMins').value) || 0;
    const lateCount = parseInt(document.getElementById('metaLateCount').value) || 0;

    const phUnworked = parseFloat(document.getElementById('metaPHUnworked').value) || 0;
    const phWorked = parseFloat(document.getElementById('metaPHWorked').value) || 0;
    const phWorkedHrs = parseFloat(document.getElementById('metaPHWorkedHrs').value) || 0;

    if (globalSettings.calcMode === 'hourly') {
        const majorityHours = parseFloat(document.getElementById('metaTotalHrs').dataset.majorityHours) || 208;
        if (fullBasic > 0 && majorityHours > 0) {
            const autoHrRate = fullBasic / majorityHours;
            document.getElementById('inpHourlyRate').value = autoHrRate.toFixed(2);
        }

        const hrRate = getVal('inpHourlyRate');
        baseGross = hrRate * (parseFloat(document.getElementById('metaTotalHrs').value) || 0);
        baseGross += hrRate * 8 * phUnworked; // Unworked PH gets 8 hours normal pay
        
        phExtraGross = hrRate * phWorkedHrs * 2; // Worked PH gets extra 2x pay

        document.getElementById('prorationMsg').style.visibility = 'hidden';

        if (globalSettings.lateMode === 'times') {
            autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
            document.getElementById('lateFormulaText').innerText = `Fine: ${lateCount} times x RM${globalSettings.lateFixedAmount}`;
        } else document.getElementById('lateFormulaText').innerText = "Unpaid by default in Hourly mode.";
    } else {
        const stdDays = getVal('inpStdDays') || 26; 
        
        const paidLeaveCount = (parseFloat(document.getElementById('metaAnnualLeave').value) || 0) + (parseFloat(document.getElementById('metaMedicalLeave').value) || 0);
        // Base Pay = Worked + Paid Leaves + Unworked PH
        const basePayableDays = (parseFloat(document.getElementById('metaDaysAct').value) || 0) + paidLeaveCount + phUnworked;

        const dailyRate = fullBasic / stdDays;
        baseGross = Math.min(dailyRate * basePayableDays, fullBasic);
        
        // Worked PH gets extra 2x day rate (because 1x is already in actDays/baseGross)
        phExtraGross = phWorked * 2 * dailyRate;

        const msg = document.getElementById('prorationMsg');
        if (basePayableDays < stdDays) { msg.style.visibility = 'visible'; msg.innerText = `Pro-rated: ${basePayableDays} / ${stdDays} days`; } 
        else msg.style.visibility = 'hidden';

        if (globalSettings.lateMode === 'times') {
            autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
            document.getElementById('lateFormulaText').innerText = `Fine: ${lateCount} times x RM${globalSettings.lateFixedAmount}`;
        } else {
            autoLateDeduct = ((dailyRate / 8) / 60) * lateMins;
            document.getElementById('lateFormulaText').innerText = `Auto deduct: ${lateMins} mins`;
        }
    }
    
    document.getElementById('dispGrossBasic').value = formatMoney(baseGross);
    document.getElementById('calcPHExtra').value = phExtraGross.toFixed(2);

    if(!document.getElementById('inpLateDed').value && autoLateDeduct > 0) document.getElementById('inpLateDed').value = autoLateDeduct.toFixed(2);

    if (autoUpdateStatutory) {
        const uid = document.getElementById('staffSelect').value;
        const staff = staffMap[uid]; 
        
        if (staff && staff.statutory) {
            const epfRaw = staff.statutory.epf?.contrib || '';
            const eisRaw = staff.statutory.eis || '';

            document.getElementById('hintEPF').innerText = epfRaw ? `(${epfRaw}${epfRaw.toString().includes('%') ? '' : '%'})` : '';
            document.getElementById('hintEIS').innerText = eisRaw ? `(${eisRaw}${eisRaw.toString().includes('%') ? '' : '%'})` : '';

            const epfAmt = calculateStatutoryAmount(epfRaw, baseGross, true); 
            const eisAmt = calculateStatutoryAmount(eisRaw, baseGross, true); 

            if (epfAmt > 0) document.getElementById('inpEPF').value = epfAmt.toFixed(2);
            if (eisAmt > 0) document.getElementById('inpEIS').value = eisAmt.toFixed(2);
        } else {
            document.getElementById('hintEPF').innerText = ''; document.getElementById('hintEIS').innerText = '';
        }
    }

    const grossTotal = baseGross + phExtraGross + getVal('inpComm') + getVal('inpOT') + getVal('inpAllowance');
    const totalDed = getVal('inpEPF') + getVal('inpSOCSO') + getVal('inpEIS') + getVal('inpPCB') + getVal('inpLateDed') + getVal('inpAdvance'); 
    document.getElementById('dispNet').innerText = "RM " + formatMoney(grossTotal - totalDed);
};

window.savePayslipForm = async () => {
    const uid = document.getElementById('staffSelect').value;
    const month = document.getElementById('formMonthPicker').value;
    if(!uid || !month) return showStatusAlert('statusMessage', "Select staff and month", false);

    showLoading();
    const staff = staffMap[uid];
    const getVal = (id) => parseFloat(document.getElementById(id).value) || 0;
    const status = document.getElementById('formStatus').value;
    
    const baseGross = parseFloat(document.getElementById('dispGrossBasic').value.replace(/,/g,'')) || 0;
    const phExtraGross = parseFloat(document.getElementById('calcPHExtra').value) || 0;

    const grossTotal = baseGross + phExtraGross + getVal('inpComm') + getVal('inpOT') + getVal('inpAllowance');
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
        final_basic: baseGross, 
        earnings: { commission: getVal('inpComm'), ot: getVal('inpOT'), allowance: getVal('inpAllowance'), phPay: phExtraGross, total: grossTotal },
        deductions: { epf: getVal('inpEPF'), socso: getVal('inpSOCSO'), eis: getVal('inpEIS'), tax: getVal('inpPCB'), late: getVal('inpLateDed'), advance: getVal('inpAdvance'), total: totalDed },
        employer_epf: getVal('inpEmpEPF'), employer_socso: getVal('inpEmpSOCSO'), employer_eis: getVal('inpEmpEIS'),
        attendanceStats: {
            stdDays: getVal('inpStdDays'), 
            actDays: document.getElementById('metaDaysAct').value,
            annualLeave: document.getElementById('metaAnnualLeave').value,
            medicalLeave: document.getElementById('metaMedicalLeave').value,
            unpaidLeave: document.getElementById('metaUnpaidLeave').value,
            phUnworked: document.getElementById('metaPHUnworked').value,
            phWorked: document.getElementById('metaPHWorked').value,
            totalHrs: document.getElementById('metaTotalHrs').value,
            lateMins: document.getElementById('metaLateMins').value, 
            lateCount: document.getElementById('metaLateCount').value, 
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

        if (window.currentViewingPayslipId) {
            showStatusAlert('statusMessage', 'Saved! Moving to next...', true);
            window.navigatePayslip(1); 
        } else {
            formModal.hide();
            showStatusAlert('statusMessage', 'Payslip saved successfully.', true); 
        }
        
        window.loadPayroll();
    } catch(e) { 
        hideLoading();
        showStatusAlert('statusMessage', "Save error: " + e.message, false); 
    }
};

window.loadPayroll = async () => {
    const month = document.getElementById('globalMonthPicker').value;
    if(!month) return;
    showLoading(); 
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
                    <button class="btn btn-sm btn-outline-dark" onclick="window.viewPayslip('${d.id}')" title="Print/View"><i data-lucide="printer" class="size-4"></i></button>
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

window.openCreateModal = () => {
    window.currentViewingPayslipId = null;
    const navGroup = document.getElementById('navPayslipGroup');
    if (navGroup) navGroup.style.display = 'none';

    document.getElementById('payslipForm').reset();
    document.getElementById('editDocId').value = "";
    document.getElementById('pendingAdvanceIds').value = "";
    document.getElementById('formModalTitle').innerText = "Create New Payslip";
    document.getElementById('staffSelect').disabled = false;
    document.getElementById('formMonthPicker').disabled = false;
    
    document.getElementById('dispNet').innerText = "RM 0.00";
    document.getElementById('dispGrossBasic').value = "0.00";
    document.getElementById('calcPHExtra').value = "0";
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

    window.currentViewingPayslipId = id;
    const navGroup = document.getElementById('navPayslipGroup');
    if (navGroup) navGroup.style.display = 'inline-flex';

    document.getElementById('editDocId').value = id;
    document.getElementById('formModalTitle').innerText = "Edit Payslip - " + d.staffName;
    
    document.getElementById('staffSelect').value = d.uid;
    document.getElementById('staffSelect').disabled = true; 
    document.getElementById('formMonthPicker').value = d.month;
    document.getElementById('formMonthPicker').disabled = true; 

    document.getElementById('inpBasic').value = d.basic; 
    document.getElementById('calcPHExtra').value = d.earnings.phPay || 0;
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
        
        document.getElementById('metaAnnualLeave').value = d.attendanceStats.annualLeave || 0;
        document.getElementById('metaMedicalLeave').value = d.attendanceStats.medicalLeave || 0;
        document.getElementById('metaUnpaidLeave').value = d.attendanceStats.unpaidLeave || 0;
        document.getElementById('metaPHUnworked').value = d.attendanceStats.phUnworked || 0;
        document.getElementById('metaPHWorked').value = d.attendanceStats.phWorked || 0;
        
        const al = parseFloat(d.attendanceStats.annualLeave) || 0;
        const ml = parseFloat(d.attendanceStats.medicalLeave) || 0;
        const totalPaidLeave = al + ml;

        const phOff = parseFloat(d.attendanceStats.phUnworked) || 0;
        const phWork = parseFloat(d.attendanceStats.phWorked) || 0;
        
        document.getElementById('dispPaidLeave').innerHTML = `${totalPaidLeave} <span style="font-size:0.6rem">Days (AL:${al} ML:${ml})</span>`;
        document.getElementById('dispActDays').innerHTML = `${d.attendanceStats.actDays || 0} <span style="font-size:0.6rem">Days</span>`;
        document.getElementById('dispPH').innerHTML = `${phOff} / ${phWork} <span style="font-size:0.6rem">Off/Work</span>`;
        document.getElementById('dispPayableDays').innerHTML = `${parseFloat(d.attendanceStats.actDays || 0) + totalPaidLeave + phOff} <span style="font-size:0.6rem">Days</span>`;

        document.getElementById('metaTotalHrs').value = d.attendanceStats.totalHrs || 0; 
        document.getElementById('metaLateMins').value = d.attendanceStats.lateMins || 0;
        document.getElementById('metaLateCount').value = d.attendanceStats.lateCount || 0;
        
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
    if(d.earnings.phPay > 0) extraEarnRows += `<tr><td style="color:#f59e0b; font-weight:bold;">PUBLIC HOLIDAY PAY (EXTRA 2x)</td><td style="text-align: right; color:#f59e0b; font-weight:bold;">${formatMoney(d.earnings.phPay)}</td><td></td><td></td></tr>`;
    if(d.earnings.commission > 0) extraEarnRows += `<tr><td>COMMISSION</td><td style="text-align: right;">${formatMoney(d.earnings.commission)}</td><td></td><td></td></tr>`;
    if(d.earnings.ot > 0) extraEarnRows += `<tr><td>OVERTIME</td><td style="text-align: right;">${formatMoney(d.earnings.ot)}</td><td></td><td></td></tr>`;
    if(d.earnings.allowance > 0) extraEarnRows += `<tr><td>ALLOWANCE</td><td style="text-align: right;">${formatMoney(d.earnings.allowance)}</td><td></td><td></td></tr>`;

    if(d.deductions.eis > 0) extraDedRows += `<tr><td></td><td></td><td style="padding-left: 20px;">EIS (Employee)</td><td style="text-align: right;">${formatMoney(d.deductions.eis)}</td></tr>`;
    if(d.deductions.tax > 0) extraDedRows += `<tr><td></td><td></td><td style="padding-left: 20px;">PCB / TAX</td><td style="text-align: right;">${formatMoney(d.deductions.tax)}</td></tr>`;
    if(d.deductions.late > 0) extraDedRows += `<tr><td></td><td></td><td style="padding-left: 20px; color:red;">LATE DEDUCTION</td><td style="text-align: right; color:red;">${formatMoney(d.deductions.late)}</td></tr>`;
    if(d.deductions.advance > 0) extraDedRows += `<tr><td></td><td></td><td style="padding-left: 20px; color:red;">SALARY ADVANCE</td><td style="text-align: right; color:red;">${formatMoney(d.deductions.advance)}</td></tr>`;

    const stats = d.attendanceStats || {};
    const al = parseFloat(stats.annualLeave) || 0;
    const ml = parseFloat(stats.medicalLeave) || 0;
    const ul = parseFloat(stats.unpaidLeave) || 0;
    const phUnworked = parseFloat(stats.phUnworked) || 0;
    const phWorked = parseFloat(stats.phWorked) || 0;
    const actDays = parseFloat(stats.actDays) || 0;
    const payableDays = actDays + al + ml + phUnworked;

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
                    <div class="info-row mt-1 pt-1 border-top border-secondary border-opacity-25 text-primary fw-bold"><span>Pay Period</span> <span>: ${d.month}</span></div>
                </div>
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
                <b>Attendance Stats:</b> Payable Days: ${payableDays} / ${stats.stdDays || 26} (Worked: ${actDays}, AL: ${al}, ML: ${ml}, PH Off: ${phUnworked}, PH Worked: ${phWorked}, Unpaid: ${ul})
                <br><b>Late Stats:</b> ${stats.lateCount || 0} times (${stats.lateMins || 0} minutes)
            </div>
        </div>
    `;
    document.getElementById('printArea').innerHTML = html;
    printModal.show();
};

window.publishAll = async () => {
    const drafts = currentPayrollData.filter(d => d.status === 'Draft');
    if(drafts.length === 0) return showStatusAlert('statusMessage', "No draft payslips found to publish.", false);
    
    if(!confirm(`Are you sure you want to officially publish ${drafts.length} payslip(s)?\n\nThis will make them visible to staff and PERMANENTLY deduct their approved Salary Advances.`)) return;
    
    showLoading(); 
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
        showStatusAlert('statusMessage', `Successfully published ${drafts.length} payslips!`, true);
        window.loadPayroll();

    } catch (e) { 
        hideLoading();
        console.error(e);
        showStatusAlert('statusMessage', "Publish Failed: " + e.message, false); 
    } 
};

// ==========================================
// 4. BATCH GENERATOR ENGINE (AUTO GENERATE ALL)
// ==========================================
window.generateAllDrafts = async () => {
    const monthStr = document.getElementById('globalMonthPicker').value;
    if(!monthStr) return showStatusAlert('statusMessage', "Please select a month first.", false);
    
    if(!confirm(`⚠️ AUTO GENERATION WARNING\n\nThis will automatically calculate and generate DRAFT payslips for ALL active staff for ${monthStr} based on their attendance, leaves, schedules, and advances.\n\nAny existing 'Draft' for this month will be OVERWRITTEN.\nExisting 'Published' payslips will be SKIPPED.\n\nProceed?`)) return;

    showLoading();
    document.getElementById('loadingText').innerText = "Processing automated payroll batch...";

    try {
        const batch = writeBatch(db);
        let generatedCount = 0;
        let skippedCount = 0;

        const [year, month] = monthStr.split('-');
        const startDate = `${monthStr}-01`;
        const daysInMonth = new Date(year, month, 0).getDate();
        const endDate = `${monthStr}-${daysInMonth}`;

        const [allSchedSnap, allLeavesSnap, allAttSnap, allAdvSnap] = await Promise.all([
            getDocs(query(collection(db, "schedules"), where("date", ">=", startDate), where("date", "<=", endDate))),
            getDocs(query(collection(db, "leaves"), where("status", "==", "Approved"))),
            getDocs(query(collection(db, "attendance"), where("date", ">=", startDate), where("date", "<=", endDate))),
            getDocs(query(collection(db, "salary_advances"), where("status", "==", "Approved"), where("isDeducted", "==", false)))
        ]);

        const schedules = {}; const leaves = []; const attendances = {}; const advances = {};
        
        const userSchedHours = {};
        allSchedSnap.forEach(d => { 
            const s = d.data(); 
            if(!schedules[s.userId]) schedules[s.userId] = []; 
            schedules[s.userId].push(s); 
            
            if(s.start && s.end) {
                const start = s.start.toDate ? s.start.toDate() : new Date(s.start);
                const end = s.end.toDate ? s.end.toDate() : new Date(s.end);
                let duration = (end - start) / 3600000;
                duration -= (s.breakMins || 0) / 60;
                if (duration > 0) userSchedHours[s.userId] = (userSchedHours[s.userId] || 0) + duration;
            }
        });

        const hrFreq = {}; 
        Object.values(userSchedHours).forEach(h => {
            const key = h.toFixed(1);
            if (h > 0) hrFreq[key] = (hrFreq[key] || 0) + 1;
        });

        let majorityHours = 208; let maxHrFreq = 0;
        for (let h in hrFreq) { 
            if (hrFreq[h] > maxHrFreq) { 
                maxHrFreq = hrFreq[h]; 
                majorityHours = parseFloat(h); 
            } 
        }

        allLeavesSnap.forEach(d => leaves.push(d.data()));
        allAttSnap.forEach(d => { 
            const a = d.data(); 
            if(a.verificationStatus === 'Verified') {
                if(!attendances[a.uid]) attendances[a.uid] = {};
                if(!attendances[a.uid][a.date]) attendances[a.uid][a.date] = { in: null, out: null, breakOut: null, breakIn: null };
                if(a.session === 'Clock In') attendances[a.uid][a.date].in = a.manualIn || a.timeIn || a.timestamp;
                if(a.session === 'Clock Out') attendances[a.uid][a.date].out = a.manualOut || a.timeOut || a.timestamp;
                if(a.session === 'Break Out') attendances[a.uid][a.date].breakOut = a.manualOut || a.timeOut || a.timestamp;
                if(a.session === 'Break In') attendances[a.uid][a.date].breakIn = a.manualIn || a.timeIn || a.timestamp;
            }
        });
        allAdvSnap.forEach(d => { 
            const a = d.data(); 
            if (a.isTransferred === true) {
                advances[a.uid] = (advances[a.uid] || 0) + a.amount; 
            }
        });

        for (const [uid, staff] of Object.entries(staffMap)) {
            const payslipId = `${uid}_${monthStr}`;
            
            const existingPs = currentPayrollData.find(p => p.id === payslipId);
            if (existingPs && existingPs.status === 'Published') {
                skippedCount++;
                continue; 
            }

            const searchIds = [uid];
            if (staff.authUid) searchIds.push(staff.authUid);

            let mySchedCount = 0; let majorityDays = 26; 
            searchIds.forEach(sid => { if(schedules[sid]) mySchedCount += schedules[sid].length; });

            let actWorkedDays = 0, totalWorkMs = 0, totalLateMs = 0, lateCount = 0;
            let phUnworkedDays = 0, phWorkedDays = 0, phWorkedMs = 0;
            const satMulti = parseFloat(globalSettings.satMultiplier || 1.0);
            
            const toDateObj = (t, dateStr) => {
                if(!t) return null;
                if(t.toDate) return t.toDate();
                if(typeof t === 'string' && t.includes(':')) return new Date(`${dateStr}T${t}:00`);
                return new Date(t);
            };

            const myAtt = searchIds.map(sid => attendances[sid] || {}).reduce((acc, curr) => ({...acc, ...curr}), {});
            const mySchedsList = searchIds.map(sid => schedules[sid] || []).flat().reduce((acc, s) => { acc[s.date] = s; return acc; }, {});

            // 🟢 核心按天计算逻辑
            for (let d = 1; d <= daysInMonth; d++) {
                const dateStr = `${year}-${month}-${String(d).padStart(2, '0')}`;
                const records = myAtt[dateStr];
                const sched = mySchedsList[dateStr];
                const isScheduled = !!sched;
                const isPH = !!holidaysMap[dateStr];
                const validPH = isPH && isScheduled; // 必须有排班的假期才算数

                if (records && records.in) {
                    const isSat = new Date(dateStr).getDay() === 6;
                    actWorkedDays += isSat ? satMulti : 1;

                    if (sched && sched.start) {
                        const inTime = toDateObj(records.in, dateStr);
                        const schedStart = toDateObj(sched.start, dateStr);
                        if (inTime > schedStart) { totalLateMs += (inTime - schedStart); lateCount++; }
                    }

                    let workMsThisDay = 0;
                    if (records.out) {
                        const inTime = toDateObj(records.in, dateStr);
                        const outTime = toDateObj(records.out, dateStr);
                        workMsThisDay = outTime - inTime;
                        
                        if (records.breakOut && records.breakIn) {
                            const bOut = toDateObj(records.breakOut, dateStr);
                            const bIn = toDateObj(records.breakIn, dateStr);
                            const breakDur = bIn - bOut;
                            if (breakDur > 0) workMsThisDay -= breakDur;
                        }

                        // 🟢 新增：工时上限逻辑 (Capping to Scheduled Hours)
                        if (sched && sched.start && sched.end) {
                            const sStart = toDateObj(sched.start, dateStr);
                            const sEnd = toDateObj(sched.end, dateStr);
                            let schedDurMs = sEnd - sStart;
                            if (sched.breakMins) schedDurMs -= sched.breakMins * 60000;

                            if (schedDurMs > 0 && workMsThisDay > schedDurMs) {
                                workMsThisDay = schedDurMs;
                            }
                        }

                        if(workMsThisDay > 0) totalWorkMs += workMsThisDay;
                    }
                    
                    if (validPH) {
                        phWorkedDays++;
                        phWorkedMs += (workMsThisDay > 0 ? workMsThisDay : 0);
                    }
                } else {
                    // 没有打卡
                    if (validPH) {
                        phUnworkedDays++; // 有排班的假期且没打卡，算 Paid PH Off，忽略任何其他 Leave 申请
                    }
                }
            }

            let annualLeaveCount = 0, medicalLeaveCount = 0, unpaidLeaveCount = 0;
            leaves.forEach(l => {
                if (searchIds.includes(l.uid) || searchIds.includes(l.authUid)) {
                    const [sY, sM, sD] = l.startDate.split('-');
                    const [eY, eM, eD] = l.endDate.split('-');
                    let curr = new Date(sY, sM - 1, sD);
                    const endD = new Date(eY, eM - 1, eD);

                    while(curr <= endD) {
                        const dStr = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
                        
                        // 🟢 忽略有效的公共假期
                        const validPH = !!holidaysMap[dStr] && !!mySchedsList[dStr];
                        if(dStr >= startDate && dStr <= endDate && !myAtt[dStr]?.in && !validPH) {
                            if (l.type === 'Annual Leave' || l.type === '年假' || l.type === 'Cuti Tahunan') annualLeaveCount++;
                            else if (l.type === 'Medical Leave' || l.type === '病假' || l.type === 'Cuti Sakit') medicalLeaveCount++;
                            else unpaidLeaveCount++;
                        }
                        curr.setDate(curr.getDate() + 1);
                    }
                }
            });

            const paidLeaveCount = annualLeaveCount + medicalLeaveCount;
            const totalDecimalHrs = totalWorkMs / 3600000;
            const phWorkedHrsDec = phWorkedMs / 3600000;
            const totalLateMins = Math.floor(totalLateMs / 60000);
            
            let totalAdvanceDed = 0;
            searchIds.forEach(sid => { if(advances[sid]) totalAdvanceDed += advances[sid]; });

            const fullBasic = parseFloat(staff.payroll?.basic) || 0;
            let baseGross = 0, phExtraGross = 0, autoLateDeduct = 0;

            if (globalSettings.calcMode === 'hourly') {
                const hrRate = parseFloat(staff.payroll?.hourlyRate) || (fullBasic > 0 ? (fullBasic / majorityHours) : 0);
                
                baseGross = hrRate * totalDecimalHrs;
                baseGross += hrRate * 8 * phUnworkedDays; 
                phExtraGross = hrRate * phWorkedHrsDec * 2;

                if (globalSettings.lateMode === 'times') {
                    autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
                }
            } else {
                const basePayableDays = actWorkedDays + paidLeaveCount + phUnworkedDays;
                const dailyRate = fullBasic / majorityDays;
                baseGross = Math.min(dailyRate * basePayableDays, fullBasic); 
                
                phExtraGross = phWorkedDays * 2 * dailyRate;

                if (globalSettings.lateMode === 'times') {
                    autoLateDeduct = lateCount * (parseFloat(globalSettings.lateFixedAmount) || 0);
                } else {
                    autoLateDeduct = ((dailyRate / 8) / 60) * totalLateMins;
                }
            }

            let epfAmt = 0, eisAmt = 0;
            if (staff.statutory) {
                const epfRaw = staff.statutory.epf?.contrib || '';
                const eisRaw = staff.statutory.eis || '';
                epfAmt = calculateStatutoryAmount(epfRaw, baseGross, true);
                eisAmt = calculateStatutoryAmount(eisRaw, baseGross, true);
            }

            const grossTotal = baseGross + phExtraGross; 
            const totalDed = epfAmt + eisAmt + autoLateDeduct + totalAdvanceDed;
            const net = grossTotal - totalDed;

            const payload = {
                uid, month: monthStr,
                staffName: staff.displayName,
                staffCode: staff.displayId,
                icNo: staff.personal?.icNo || '-',
                epfNo: staff.statutory?.epf?.no || '-',
                socsoNo: staff.statutory?.socso?.no || '-',
                department: staff.employment?.dept || '-',
                bankAcc: staff.payroll?.bank1?.acc || '-',
                bankName: staff.payroll?.bank1?.name || '-',
                basic: fullBasic,
                final_basic: parseFloat(baseGross.toFixed(2)), 
                earnings: { commission: 0, ot: 0, allowance: 0, phPay: parseFloat(phExtraGross.toFixed(2)), total: parseFloat(grossTotal.toFixed(2)) },
                deductions: { epf: parseFloat(epfAmt.toFixed(2)), socso: 0, eis: parseFloat(eisAmt.toFixed(2)), tax: 0, late: parseFloat(autoLateDeduct.toFixed(2)), advance: parseFloat(totalAdvanceDed.toFixed(2)), total: parseFloat(totalDed.toFixed(2)) },
                employer_epf: 0, employer_socso: 0, employer_eis: 0,
                attendanceStats: {
                    stdDays: majorityDays, actDays: actWorkedDays,
                    annualLeave: annualLeaveCount, medicalLeave: medicalLeaveCount, unpaidLeave: unpaidLeaveCount,
                    phUnworked: phUnworkedDays, phWorked: phWorkedDays,
                    totalHrs: totalDecimalHrs.toFixed(2),
                    lateMins: totalLateMins, lateCount: lateCount, 
                    mode: globalSettings.calcMode
                },
                gross: parseFloat(grossTotal.toFixed(2)), net: parseFloat(net.toFixed(2)), 
                status: 'Draft', 
                updatedAt: serverTimestamp(),
                createdAt: existingPs ? existingPs.createdAt : serverTimestamp()
            };

            batch.set(doc(db, "payslips", payslipId), payload);
            generatedCount++;
        }

        if (generatedCount > 0) {
            await batch.commit();
            await logAdminAction(db, auth.currentUser, "BATCH_GENERATE_PAYSLIPS", "MULTIPLE", null, { count: generatedCount, month: monthStr });
        }

        hideLoading();
        let msg = `Batch generation complete!\nGenerated ${generatedCount} Drafts.`;
        if(skippedCount > 0) msg += `\nSkipped ${skippedCount} already Published payslips.`;
        alert(msg); 
        
        window.loadPayroll();

    } catch (e) {
        hideLoading();
        console.error(e);
        alert("Batch Generation Failed: " + e.message);
    }
};

// ==========================================
// 5. QUICK NAVIGATION (LEFT/RIGHT ARROWS)
// ==========================================
window.currentViewingPayslipId = null;

window.navigatePayslip = function(direction) {
    if (!window.currentViewingPayslipId || !currentPayrollData || currentPayrollData.length === 0) return;

    const currentIndex = currentPayrollData.findIndex(p => p.id === window.currentViewingPayslipId);
    if (currentIndex === -1) return;

    let newIndex = currentIndex + direction;
    if (newIndex < 0) newIndex = currentPayrollData.length - 1;
    if (newIndex >= currentPayrollData.length) newIndex = 0;

    const nextPayslip = currentPayrollData[newIndex];
    
    if (nextPayslip) {
        const modalBody = document.querySelector('#payslipFormModal .modal-body');
        if (modalBody) {
            modalBody.style.opacity = '0.3';
            setTimeout(() => { modalBody.style.opacity = '1'; }, 150);
        }
        window.openEditModal(nextPayslip.id);
    }
};

document.addEventListener('keydown', (e) => {
    const formModalEl = document.getElementById('payslipFormModal');
    
    if (formModalEl && formModalEl.classList.contains('show') && window.currentViewingPayslipId) {
        
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
            if (e.altKey && e.key === 'ArrowLeft') window.navigatePayslip(-1);
            if (e.altKey && e.key === 'ArrowRight') window.navigatePayslip(1);
            return; 
        }

        if (e.key === 'ArrowLeft') {
            e.preventDefault(); 
            window.navigatePayslip(-1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            window.navigatePayslip(1);
        }
    }
});