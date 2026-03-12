import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, getDocs, getDoc, setDoc, doc, writeBatch, deleteDoc, onSnapshot, query, where, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";
import { requireAdmin } from "./auth-guard.js";
 
// 🟢 导入 utils 的所有公用方法
import { formatTime, normalizeDate, logAdminAction, showLoading, hideLoading, showStatusAlert, formatMoney } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 仅保留 formatMoney 因为部分内联 JS(如果存在的话) 可能需要
window.formatMoney = formatMoney;
window.formatTime = formatTime;
window.normalizeDate = normalizeDate;

window.onerror = function(msg) {
    const loadingText = document.getElementById('loadingText');
    if(loadingText) { loadingText.innerText = "Error: " + msg; loadingText.classList.add('text-danger'); }
};

let calendar;
let rawSchedules = [];
let holidayCache = {}; 
let leaveCache = {}; 
let presetCache = []; 
let allStaff = []; 
let listSelectedIds = new Set();
let currentManagerDate = null;
let currentFilterIds = null;

let dayManagerModal, bulkModal, listEditModal, presetModal, staffAnalyticsModal;

function getTodayStr() {
    const now = new Date();
    return normalizeDate(`${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`);
}

requireAdmin(app, db, async (user) => {
    document.getElementById('loadingText').innerText = "Loading Schedule...";
    
    showLoading(); // 🟢 使用公用 Loading
    
    if (typeof bootstrap !== 'undefined') {
        dayManagerModal = new bootstrap.Modal(document.getElementById('dayManagerModal'));
        bulkModal = new bootstrap.Modal(document.getElementById('bulkModal'));
        listEditModal = new bootstrap.Modal(document.getElementById('listEditModal'));
        presetModal = new bootstrap.Modal(document.getElementById('presetModal'));
        staffAnalyticsModal = new bootstrap.Modal(document.getElementById('staffAnalyticsModal'));
    }

    initFilters();
    initCalendar();
    initDateConstraints();
    initPresetFormUI(); 
    
    await Promise.all([ loadStaffList(), loadHolidays(), loadLeaves(), loadPresets() ]);
    loadSchedules(); 
    
    setTimeout(() => { 
        if (calendar) calendar.updateSize(); 
        hideLoading(); 
        document.getElementById('mainContainer').classList.remove('d-none');
    }, 300);
    lucide.createIcons();
});

function initDateConstraints() {
    const todayStr = getTodayStr();
    const startInput = document.getElementById('bulkStartDate');
    const endInput = document.getElementById('bulkEndDate');
    const monthInput = document.getElementById('bulkMonthPicker');
    
    startInput.min = todayStr;
    endInput.min = todayStr;
    monthInput.min = todayStr.substring(0, 7);

    startInput.addEventListener('change', function() {
        endInput.min = this.value;
        if (endInput.value && endInput.value < this.value) endInput.value = this.value;
    });
}

function initPresetFormUI() {
    const container = document.getElementById('presetDaysContainer');
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let html = '';
    days.forEach((day, index) => {
        const jsDayIndex = index === 6 ? 0 : index + 1;
        html += `
            <div class="preset-day-row" data-day="${jsDayIndex}">
                <div class="form-check m-0">
                    <input class="form-check-input day-active" type="checkbox" checked id="pd_${jsDayIndex}">
                </div>
                <div class="preset-day-label">${day}</div>
                <input type="time" class="form-control form-control-sm day-start" value="09:00">
                <span class="mx-1">-</span>
                <input type="time" class="form-control form-control-sm day-end" value="18:00">
                <input type="number" class="form-control form-control-sm day-break ms-2" style="width:60px" placeholder="Brk" value="60">
                <small class="text-muted ms-1">m</small>
            </div>
        `;
    });
    container.innerHTML = html;
}

function loadSchedules() {
    onSnapshot(query(collection(db, "schedules")), (snapshot) => {
        rawSchedules = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            if(d.start && d.end) {
                const start = d.start.toDate();
                const end = d.end.toDate();
                const hour = start.getHours();
                let duration = (end - start) / (1000 * 60 * 60);
                const breakMins = d.breakMins || 0;
                duration -= (breakMins / 60);
                if (duration < 0) duration = 0;
                
                rawSchedules.push({
                    id: doc.id,
                    userId: d.userId,
                    empName: d.empName,
                    date: d.date, 
                    start: start,
                    end: end,
                    breakMins: breakMins,
                    shiftType: hour >= 13 ? 'Evening' : 'Morning',
                    hours: duration, 
                    notes: d.notes,
                    clockIn: d.clockIn ? d.clockIn.toDate() : null
                });
            }
        });
        window.renderAnalytics(); 
        updateCalendarEvents();
        window.filterTable();
        if(dayManagerModal._element.classList.contains('show') && currentManagerDate) {
            renderDayRoster(); renderAvailableStaffSelect();
        }
    });
}

async function loadLeaves() {
    const q = query(collection(db, "leaves"), where("status", "==", "Approved"));
    onSnapshot(q, (snapshot) => {
        leaveCache = {};
        const leaveEvents = [];
        snapshot.forEach(doc => {
            try {
                const data = doc.data();
                if(!data.startDate || !data.endDate) return;
                const staffId = String(data.uid || data.userId).trim();
                const sParts = data.startDate.split('-').map(Number);
                const eParts = data.endDate.split('-').map(Number);
                let current = new Date(Date.UTC(sParts[0], sParts[1] - 1, sParts[2], 12, 0, 0));
                const end = new Date(Date.UTC(eParts[0], eParts[1] - 1, eParts[2], 12, 0, 0));
                while (current <= end) {
                    const dateStr = current.toISOString().split('T')[0];
                    const key = `${staffId}_${dateStr}`;
                    leaveCache[key] = data.leaveType || "On Leave";
                    leaveEvents.push({ title: `🏖️ ${data.name}`, start: dateStr, allDay: true, display: 'background', className: 'leave-bg' });
                    current.setUTCDate(current.getUTCDate() + 1);
                }
            } catch(e) {}
        });
        const old = calendar.getEventSourceById('leaves');
        if(old) old.remove();
        calendar.addEventSource({ id: 'leaves', events: leaveEvents });
        if(dayManagerModal._element.classList.contains('show') && currentManagerDate) renderAvailableStaffSelect();
    });
}

async function loadStaffList() {
    allStaff = []; 
    const bulkSelect = document.getElementById('bulkStaffSelect'); 
    bulkSelect.innerHTML = '';
    const q = query(collection(db, "users"), where("role", "in", ["staff", "admin"]));
    const snap = await getDocs(q);
    snap.forEach(d => { 
        const data = d.data();
        if (data.status === 'disabled') return;
        const name = data.personal?.name || "Unknown";
        const staffId = String(data.uid || d.id).trim();
        allStaff.push({ 
            id: staffId, 
            name: name,
            joinDate: data.employment?.joinDate 
        }); 
        bulkSelect.appendChild(new Option(name, staffId)); 
    });
}

// --- DAY MANAGER ---
window.openDayManager = function(dateStr, filterIds = null, preStart = "", preEnd = "") {
    currentManagerDate = dateStr;
    currentFilterIds = filterIds;
    const todayStr = getTodayStr();
    const titleEl = document.getElementById('dayManagerTitle');
    if (filterIds && filterIds.length > 0) {
        titleEl.innerHTML = `Shift Details <span class="badge bg-primary ms-2">${filterIds.length} Staff</span>`;
        document.getElementById('dmStartTime').value = preStart;
        document.getElementById('dmEndTime').value = preEnd;
    } else {
        titleEl.innerText = `Manage Schedule: ${dateStr}`;
        document.getElementById('dmStartTime').value = "";
        document.getElementById('dmEndTime').value = "";
    }
    const addPanel = document.querySelector('#dayManagerModal .col-md-5');
    if (dateStr < todayStr) {
        addPanel.style.opacity = '0.5';
        addPanel.style.pointerEvents = 'none';
        if(!titleEl.innerHTML.includes('Read Only')) titleEl.innerHTML += ` <span class="badge bg-secondary">Read Only</span>`;
    } else {
        addPanel.style.opacity = '1';
        addPanel.style.pointerEvents = 'auto';
    }
    
    // 🟢 2. 使用 Toast
    if(holidayCache[dateStr]) showStatusAlert('statusMessage', `Note: ${dateStr} is a public holiday.`, true);
    
    renderDayRoster();
    renderAvailableStaffSelect();
    document.getElementById('dmPresetSelect').value = "";
    document.getElementById('dmNotes').value = "";
    document.getElementById('dmBreak').value = "60";
    dayManagerModal.show();
}

function renderDayRoster() {
    const container = document.getElementById('rosterListContainer'); 
    container.innerHTML = '';
    let shifts = rawSchedules.filter(s => s.date === currentManagerDate);
    if (currentFilterIds && currentFilterIds.length > 0) {
        shifts = shifts.filter(s => currentFilterIds.includes(s.id));
        if (shifts.length < rawSchedules.filter(s => s.date === currentManagerDate).length) {
            const resetBtn = document.createElement('div');
            resetBtn.className = 'd-grid mb-2';
            resetBtn.innerHTML = `<button class="btn btn-sm btn-outline-secondary" onclick="window.openDayManager('${currentManagerDate}')">Show All Shifts for Today</button>`;
            container.appendChild(resetBtn);
        }
    }
    document.getElementById('rosterCount').innerText = `${shifts.length} Staff`;
    if(shifts.length === 0) { container.innerHTML += '<div class="text-center text-muted small py-5">No shifts found.</div>'; return; }
    shifts.sort((a,b) => a.start - b.start);
    shifts.forEach(s => {
        const div = document.createElement('div'); div.className = 'roster-item';
        const clockInBadge = s.clockIn ? `<span class="badge bg-success bg-opacity-10 text-success border border-success ms-1" style="font-size:0.6rem;">IN</span>` : '';
        const actionBtn = s.clockIn ? `<button class="btn btn-xs text-secondary border-0" disabled title="Clocked In"><i data-lucide="lock" class="size-4"></i></button>` : `<button class="btn btn-xs btn-outline-danger border-0" onclick="window.removeShift('${s.id}')"><i data-lucide="trash-2" class="size-4"></i></button>`;
        div.innerHTML = `<div><div class="fw-bold text-dark small">${s.empName} ${clockInBadge}</div><div class="text-muted" style="font-size:0.75rem;">${formatTime(s.start)} - ${formatTime(s.end)} <span class="ms-1 badge bg-secondary bg-opacity-10 text-secondary border text-xs">-${s.breakMins}m</span> <span class="ms-2 text-info">${s.notes?'('+s.notes+')':''}</span></div></div>${actionBtn}`;
        container.appendChild(div);
    });
    lucide.createIcons();
}

function renderAvailableStaffSelect() {
    const select = document.getElementById('dmStaffSelect'); select.innerHTML = '';
    const scheduledIds = rawSchedules.filter(s => s.date === currentManagerDate).map(s => String(s.userId).trim());
    allStaff.forEach(staff => {
        const cleanId = String(staff.id).trim();
        if (scheduledIds.includes(cleanId) || leaveCache[`${cleanId}_${currentManagerDate}`]) return;
        const opt = document.createElement('option'); opt.value = staff.id; opt.text = staff.name; opt.dataset.name = staff.name;
        select.appendChild(opt);
    });
}

// 🟢 SECURE: Add Shift to Day
window.addShiftToDay = async function() {
    const select = document.getElementById('dmStaffSelect');
    const selectedOptions = Array.from(select.selectedOptions);
    const start = document.getElementById('dmStartTime').value;
    const end = document.getElementById('dmEndTime').value;
    const breakMins = parseInt(document.getElementById('dmBreak').value) || 0;
    
    if(selectedOptions.length === 0 || !start || !end) {
        showStatusAlert('statusMessage', 'Please select staff and time.', false);
        return;
    }
    
    showLoading(); // 🟢
    try {
        const batch = writeBatch(db);
        const startDT = new Date(`${currentManagerDate}T${start}`);
        const endDT = new Date(`${currentManagerDate}T${end}`);
        const addedStaffIds = [];

        selectedOptions.forEach(opt => {
            const ref = doc(collection(db, "schedules"));
            batch.set(ref, { 
                userId: opt.value, 
                empName: opt.dataset.name, 
                date: currentManagerDate, 
                start: Timestamp.fromDate(startDT), 
                end: Timestamp.fromDate(endDT), 
                breakMins: breakMins, 
                notes: document.getElementById('dmNotes').value, 
                createdAt: Timestamp.now(), 
                createdBy: auth.currentUser.uid 
            });
            addedStaffIds.push(opt.value);
        });
        
        await batch.commit();
        logAdminAction(db, auth.currentUser, "ADD_SHIFT", "MULTIPLE", null, { date: currentManagerDate, start: start, end: end, count: addedStaffIds.length });
        
        document.getElementById('dmStaffSelect').selectedIndex = -1; 
        hideLoading();
        showStatusAlert('statusMessage', 'Shift added successfully.', true);
    } catch (e) {
        hideLoading();
        showStatusAlert('statusMessage', `Failed to add: ${e.message}`, false);
    }
}

// 🟢 SECURE: Remove Shift
window.removeShift = async (id) => {
    const shift = rawSchedules.find(s => s.id === id);
    if (!shift) return;
    
    if (shift.clockIn) { 
        showStatusAlert('statusMessage', `Cannot delete: ${shift.empName} has already clocked in.`, false); 
        return; 
    }
    
    if (shift.date < getTodayStr()) { 
        if (prompt(`⚠️ SECURITY WARNING\n\nDeleting PAST schedule for ${shift.empName}.\nType "DELETE" to confirm:`) !== "DELETE") return; 
    } else { 
        if(!confirm(`Delete schedule for ${shift.empName}?`)) return; 
    }
    
    showLoading();
    try { 
        await deleteDoc(doc(db, "schedules", id)); 
        logAdminAction(db, auth.currentUser, "DELETE_SHIFT", shift.userId, shift, null);
        hideLoading();
        showStatusAlert('statusMessage', 'Shift deleted.', true);
    } catch (e) { 
        hideLoading();
        showStatusAlert('statusMessage', "Failed to delete.", false); 
    }
}

// 🟢 SECURE: Delete Selected List
window.deleteSelectedList = async () => {
    if (listSelectedIds.size === 0) return;
    const idsToDelete = Array.from(listSelectedIds);
    const validDeletes = [];
    const blockedDeletes = [];
    let hasPastShifts = false;
    const todayStr = getTodayStr();
    
    const oldDataCache = []; 

    idsToDelete.forEach(id => {
        const shift = rawSchedules.find(s => s.id === id);
        if (shift) {
            if (shift.clockIn) blockedDeletes.push(shift.empName);
            else {
                validDeletes.push(id);
                oldDataCache.push(shift);
                if (shift.date < todayStr) hasPastShifts = true;
            }
        }
    });

    if (blockedDeletes.length > 0) {
        alert(`⚠️ Skipped clocked-in staff:\n${blockedDeletes.join(', ')}`);
    }
    if (validDeletes.length === 0) return;
    
    if (hasPastShifts) { 
        if (prompt(`⚠️ Confirm bulk delete (includes PAST dates)? Type "DELETE":`) !== "DELETE") return; 
    } else { 
        if (!confirm(`Delete ${validDeletes.length} selected shifts?`)) return; 
    }
    
    showLoading();
    try {
        const batch = writeBatch(db);
        validDeletes.forEach(id => batch.delete(doc(db, "schedules", id)));
        await batch.commit();

        logAdminAction(db, auth.currentUser, "BULK_DELETE_SHIFTS", "MULTIPLE", { count: validDeletes.length, records: oldDataCache }, null);

        listSelectedIds.clear();
        updateListBulkUI();
        
        hideLoading();
        showStatusAlert('statusMessage', 'Selected shifts deleted.', true);
    } catch(e) {
        hideLoading();
        showStatusAlert('statusMessage', `Delete failed: ${e.message}`, false);
    }
}

// --- BULK SCHEDULER LOGIC ---
window.toggleDateMode = () => {
    const rangeInputs = document.getElementById('rangeInputs');
    const monthInputs = document.getElementById('monthInputs');
    if(document.getElementById('modeRange').checked) {
        rangeInputs.classList.remove('d-none');
        monthInputs.classList.add('d-none');
    } else {
        rangeInputs.classList.add('d-none');
        monthInputs.classList.remove('d-none');
    }
}

window.handleBulkPresetChange = (idx) => {
    const manualBlock = document.getElementById('manualSettingsBlock');
    const previewBox = document.getElementById('presetPreviewBox');
    const previewBody = document.getElementById('presetPreviewBody');
    
    if (idx === "") {
        manualBlock.classList.remove('d-none');
        previewBox.classList.add('d-none');
    } else {
        manualBlock.classList.add('d-none');
        const p = presetCache[idx];
        if(p && p.schedule) {
            previewBox.classList.remove('d-none');
            let html = '';
            const dayMap = { "1":"Mon", "2":"Tue", "3":"Wed", "4":"Thu", "5":"Fri", "6":"Sat", "0":"Sun" };
            const sortedKeys = Object.keys(p.schedule).sort((a,b) => (a==='0'?7:a) - (b==='0'?7:b));
            
            sortedKeys.forEach(dayKey => {
                const rule = p.schedule[dayKey];
                if(rule.active) {
                    html += `<tr><td><span class="badge bg-light text-dark border">${dayMap[dayKey]}</span></td><td class="fw-bold">${rule.start} - ${rule.end}</td><td class="text-muted text-end">${rule.break}m</td></tr>`;
                }
            });
            if(html === '') html = '<tr><td colspan="3" class="text-center text-muted small">No active days in this preset.</td></tr>';
            previewBody.innerHTML = html;
        }
    }
}

// 🟢 SECURE: Run Bulk Schedule
window.runBulkSchedule = async () => {
    const staffSelect = document.getElementById('bulkStaffSelect');
    const selectedIds = Array.from(staffSelect.selectedOptions).map(o => o.value);
    const selectedStaff = allStaff.filter(s => selectedIds.includes(s.id));

    const isMonthMode = document.getElementById('modeMonth').checked;
    const presetIdx = document.getElementById('bulkPresetSelect').value;
    
    let sDateStr, eDateStr;
    if (isMonthMode) {
        const mVal = document.getElementById('bulkMonthPicker').value;
        if(!mVal) return showStatusAlert('statusMessage', 'Select a month.', false);
        sDateStr = mVal + "-01";
        const [y, m] = mVal.split('-');
        const lastDay = new Date(y, m, 0).getDate();
        eDateStr = mVal + "-" + lastDay;
    } else {
        sDateStr = document.getElementById('bulkStartDate').value;
        eDateStr = document.getElementById('bulkEndDate').value;
        if (!sDateStr || !eDateStr) return showStatusAlert('statusMessage', 'Date Range is required.', false);
    }

    if (selectedStaff.length === 0) return showStatusAlert('statusMessage', 'Select at least one staff.', false);

    document.getElementById('btnRunBulk').disabled = true;
    showLoading(); // 🟢

    try {
        const batch = writeBatch(db);
        let successCount = 0;
        
        let rules = {}; 
        if (presetIdx !== "") {
            const p = presetCache[presetIdx];
            if (p && p.schedule) rules = p.schedule;
        } else {
            const start = document.getElementById('bulkStartTime').value;
            const end = document.getElementById('bulkEndTime').value;
            const brk = parseInt(document.getElementById('bulkBreak').value) || 0;
            if(!start || !end) throw new Error("Enter Time.");
            document.querySelectorAll('.weekday-selector input:checked').forEach(cb => {
                rules[cb.value] = { active: true, start: start, end: end, break: brk };
            });
            if(Object.keys(rules).length === 0) throw new Error("Select at least one day.");
        }

        selectedStaff.forEach(u => {
            const cleanId = String(u.id).trim();
            let userStartDateStr = sDateStr;
            if (u.joinDate && u.joinDate > sDateStr) {
                userStartDateStr = u.joinDate; 
            }
            if (userStartDateStr > eDateStr) return; 

            const sParts = userStartDateStr.split('-').map(Number);
            const eParts = eDateStr.split('-').map(Number);
            let current = new Date(Date.UTC(sParts[0], sParts[1] - 1, sParts[2], 12, 0, 0));
            const end = new Date(Date.UTC(eParts[0], eParts[1] - 1, eParts[2], 12, 0, 0));
            
            while (current <= end) {
                const dateStr = current.toISOString().split('T')[0];
                const dayOfWeek = String(current.getUTCDay()); 
                const dayRule = rules[dayOfWeek];
                
                if (dayRule && dayRule.active && dayRule.start && dayRule.end && !holidayCache[dateStr]) {
                    const startDT = new Date(`${dateStr}T${dayRule.start}`);
                    const endDT = new Date(`${dateStr}T${dayRule.end}`);
                    const key = `${cleanId}_${dateStr}`;

                    if (!leaveCache[key] && !rawSchedules.some(s => String(s.userId).trim() === cleanId && s.date === dateStr)) {
                        const ref = doc(collection(db, "schedules"));
                        batch.set(ref, { 
                            userId: u.id, 
                            empName: u.name, 
                            date: dateStr, 
                            start: Timestamp.fromDate(startDT), 
                            end: Timestamp.fromDate(endDT), 
                            breakMins: parseInt(dayRule.break) || 0,
                            notes: '', 
                            createdAt: Timestamp.now(), 
                            createdBy: auth.currentUser.uid 
                        });
                        successCount++;
                    }
                }
                current.setUTCDate(current.getUTCDate() + 1);
            }
        });
        
        if (successCount > 0) {
            await batch.commit();
            logAdminAction(db, auth.currentUser, "BULK_SCHEDULE_CREATED", "MULTIPLE", null, { staffCount: selectedStaff.length, totalShifts: successCount, from: sDateStr, to: eDateStr });
        }
        
        bulkModal.hide();
        hideLoading();
        if(successCount > 0) {
            alert(`✅ Scheduled ${successCount} shifts.\n\nSmart Feature: New joiners were only scheduled from their Join Date.`);
            window.filterTable();
        } else {
            showStatusAlert('statusMessage', 'No shifts were created (maybe all overlaps/holidays).', false);
        }

    } catch (e) {
        hideLoading();
        showStatusAlert('statusMessage', e.message, false);
    } finally {
        document.getElementById('btnRunBulk').disabled = false;
    }
}

// --- UI HELPERS ---
window.openBulkModal = () => { 
    document.getElementById('bulkForm').reset(); 
    window.handleBulkPresetChange(""); 
    document.getElementById('bulkMonthPicker').value = getTodayStr().substring(0, 7);
    bulkModal.show(); 
}

window.applyDMPreset = (idx) => { 
    if(idx==="") return; 
    const p = presetCache[idx];
    if(p && p.schedule) {
        const dayIdx = new Date(currentManagerDate).getDay(); 
        const rule = p.schedule[String(dayIdx)];
        if(rule && rule.active) {
            document.getElementById('dmStartTime').value=rule.start;
            document.getElementById('dmEndTime').value=rule.end;
            document.getElementById('dmBreak').value=rule.break;
        } else {
            alert("This preset has no hours set for " + new Date(currentManagerDate).toLocaleDateString('en-US', {weekday:'long'}));
        }
    }
}

window.filterBulkStaff = function() { 
    const term=document.getElementById('bulkStaffSearch').value.toLowerCase(); 
    const s=document.getElementById('bulkStaffSelect'); 
    for(let i=0;i<s.options.length;i++) s.options[i].style.display=s.options[i].text.toLowerCase().includes(term)?"":"none"; 
}

// Calendar Event Mapping
function updateCalendarEvents() {
    calendar.removeAllEvents();
    const hEvents = []; 
    for(let d in holidayCache) hEvents.push({title: holidayCache[d], start: d, display: 'background', className: 'holiday-bg', allDay: true});
    calendar.addEventSource(hEvents);
    const groups = {};
    rawSchedules.forEach(s => {
        const timeKey = `${s.start.getTime()}-${s.end.getTime()}`;
        if(!groups[timeKey]) groups[timeKey] = { id: timeKey, start: s.start, end: s.end, ids: [], names: [], count: 0, date: s.date, type: s.shiftType };
        groups[timeKey].ids.push(s.id); groups[timeKey].names.push(s.empName); groups[timeKey].count++;
    });
    const shiftEvents = Object.values(groups).map(g => {
        const timeText = `${formatTime(g.start)} - ${formatTime(g.end)}`;
        const title = `${timeText} (${g.count})`;
        const className = g.type === 'Morning' ? 'agg-morning' : 'agg-evening';
        const startStr = g.start.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
        const endStr = g.end.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
        return { id: g.id, title: title, start: g.start, end: g.end, allDay: false, classNames: [className], extendedProps: { dateStr: g.date, filterIds: g.ids, preFillStart: startStr, preFillEnd: endStr }, borderColor: '#ffffff' };
    });
    calendar.addEventSource(shiftEvents);
}

function initCalendar() {
    var el = document.getElementById('calendar');
    calendar = new FullCalendar.Calendar(el, {
        initialView: 'dayGridMonth', height: 'auto', aspectRatio: 1.5,
        headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek' },
        eventTimeFormat: { hour: 'numeric', minute: '2-digit', meridiem: 'short' },
        displayEventTime: false,
        selectable: true, slotEventOverlap: false, eventOrder: 'start,duration',
        dateClick: (info) => window.openDayManager(info.dateStr),
        eventClick: (info) => { if(info.event.display === 'background') return; const props = info.event.extendedProps; window.openDayManager(props.dateStr, props.filterIds, props.preFillStart, props.preFillEnd); }
    });
    calendar.render();
}

async function loadHolidays() { const s=await getDoc(doc(db,"settings","holidays")); if(s.exists()) s.data().holiday_list.forEach(h=>holidayCache[h.date]=h.name); }

// --- ADVANCED PRESET MANAGER ---
async function loadPresets() { 
    const snap = await getDoc(doc(db, "settings", "shift_presets")); 
    presetCache = (snap.exists() && snap.data().presets) ? snap.data().presets : []; 
    const dm = document.getElementById('dmPresetSelect'), bs = document.getElementById('bulkPresetSelect');
    
    if (dm && bs) {
        while(dm.options.length > 1) dm.remove(1);
        while(bs.options.length > 1) bs.remove(1);

        const listContainer = document.getElementById('presetListContainer');
        listContainer.innerHTML = ''; 

        presetCache.forEach((p,i) => { 
            const t = p.name; 
            dm.appendChild(new Option(t,i)); 
            bs.appendChild(new Option(t,i)); 

            const item = document.createElement('div');
            item.className = 'p-2 border rounded bg-white d-flex justify-content-between align-items-center';
            item.innerHTML = `
                <div class="text-truncate" style="max-width: 200px;">
                    <div class="fw-bold small">${p.name}</div>
                    <div class="x-small text-muted">Advanced Rule Set</div>
                </div>
                <div class="d-flex gap-1">
                    <button class="btn btn-xs btn-outline-primary" onclick="window.editPreset(${i})"><i data-lucide="edit-2" class="size-3"></i></button>
                    <button class="btn btn-xs btn-outline-danger" onclick="window.deletePreset(${i})"><i data-lucide="trash-2" class="size-3"></i></button>
                </div>
            `;
            listContainer.appendChild(item);
        });
        lucide.createIcons();
    }
}

window.openPresetModal = () => { bulkModal.hide(); dayManagerModal.hide(); window.resetPresetForm(); presetModal.show(); }
window.closePresetModal = () => { presetModal.hide(); }

window.savePreset = async () => { 
    const idx = document.getElementById('editingPresetIndex').value;
    const name = document.getElementById('newPresetName').value;
    if(!name) return showStatusAlert('statusMessage', "Enter name", false);

    const schedule = {};
    let hasActive = false;
    document.querySelectorAll('.preset-day-row').forEach(row => {
        const dayIdx = row.dataset.day; 
        const active = row.querySelector('.day-active').checked;
        if(active) hasActive = true;
        schedule[dayIdx] = {
            active: active,
            start: row.querySelector('.day-start').value,
            end: row.querySelector('.day-end').value,
            break: parseInt(row.querySelector('.day-break').value) || 0
        };
    });

    if(!hasActive) return showStatusAlert('statusMessage', "Enable at least one day", false);

    const newObj = { name, schedule };

    if (idx === "-1") presetCache.push(newObj);
    else presetCache[idx] = newObj;
    
    showLoading();
    try {
        await setDoc(doc(db, "settings", "shift_presets"), {presets:presetCache}); 
        await loadPresets(); 
        window.resetPresetForm();
        hideLoading();
        showStatusAlert('statusMessage', 'Preset saved successfully.', true);
    } catch(e) {
        hideLoading();
        showStatusAlert('statusMessage', `Save failed: ${e.message}`, false);
    }
}

window.editPreset = (i) => {
    const p = presetCache[i];
    document.getElementById('editingPresetIndex').value = i;
    document.getElementById('newPresetName').value = p.name;
    
    if(p.schedule) {
        document.querySelectorAll('.preset-day-row').forEach(row => {
            const dayIdx = row.dataset.day;
            const rule = p.schedule[dayIdx];
            if(rule) {
                row.querySelector('.day-active').checked = rule.active;
                row.querySelector('.day-start').value = rule.start;
                row.querySelector('.day-end').value = rule.end;
                row.querySelector('.day-break').value = rule.break || 0;
            }
        });
    }
    
    document.getElementById('btnSavePreset').innerText = "Update Preset";
    document.getElementById('btnSavePreset').classList.replace('btn-primary', 'btn-warning');
    document.getElementById('btnCancelEdit').classList.remove('d-none');
}

window.resetPresetForm = () => {
    document.getElementById('editingPresetIndex').value = "-1";
    document.getElementById('newPresetName').value = "";
    document.querySelectorAll('.preset-day-row').forEach(row => {
        const d = parseInt(row.dataset.day);
        const isWk = (d >= 1 && d <= 5);
        row.querySelector('.day-active').checked = isWk;
        row.querySelector('.day-start').value = "09:00";
        row.querySelector('.day-end').value = "18:00";
        row.querySelector('.day-break').value = 60;
    });
    
    document.getElementById('btnSavePreset').innerText = "Add Preset";
    document.getElementById('btnSavePreset').classList.replace('btn-warning', 'btn-primary');
    document.getElementById('btnCancelEdit').classList.add('d-none');
}

window.deletePreset = async (i) => { 
    if(!confirm("Delete this preset?")) return;
    
    showLoading();
    try {
        presetCache.splice(i,1); 
        await setDoc(doc(db, "settings", "shift_presets"), {presets:presetCache}); 
        await loadPresets(); 
        hideLoading();
        showStatusAlert('statusMessage', 'Preset deleted.', true);
    } catch(e) {
        hideLoading();
        showStatusAlert('statusMessage', `Delete failed: ${e.message}`, false);
    }
}

window.switchView = (v) => { 
    const c=document.getElementById('calendar'), l=document.getElementById('listView'), bc=document.getElementById('btnCalendarView'), bl=document.getElementById('btnListView'); 
    if(v==='calendar'){ 
        c.classList.remove('d-none'); l.classList.add('d-none'); bc.classList.add('active'); bl.classList.remove('active'); 
        if(calendar) calendar.render(); 
    } else { 
        c.classList.add('d-none'); l.classList.remove('d-none'); bc.classList.remove('active'); bl.classList.add('active'); 
    } 
}

function renderListView(data) { 
    const t=document.getElementById('scheduleTableBody'); t.innerHTML=''; listSelectedIds.clear(); updateListBulkUI(); 
    data.sort((a,b)=>new Date(a.date)-new Date(b.date)); 
    if(data.length===0) return t.innerHTML='<tr><td colspan="8" class="text-center text-muted">No data.</td></tr>'; 
    data.forEach(i=>{ 
        const tr=document.createElement('tr'); 
        const statusIcon = i.clockIn ? `<span class="badge bg-success bg-opacity-10 text-success border border-success px-1 ms-1">IN</span>` : '';
        const actionBtn = i.clockIn ? `<button class="btn btn-xs text-secondary border-0" disabled><i data-lucide="lock" class="size-4"></i></button>` : `<button class="btn btn-xs text-danger border-0" onclick="window.removeShift('${i.id}')"><i data-lucide="trash-2" class="size-4"></i></button>`;
        tr.innerHTML=`<td><input type="checkbox" class="form-check-input list-check" value="${i.id}" onchange="window.toggleListSelection('${i.id}')"></td><td>${i.date}</td><td class="fw-bold">${i.empName} ${statusIcon}</td><td>${formatTime(i.start)}-${formatTime(i.end)}</td><td>${i.breakMins}m</td><td>${i.shiftType}</td><td class="text-muted small">${i.notes||'-'}</td><td class="text-end">${actionBtn}</td>`; 
        t.appendChild(tr); 
    }); 
    lucide.createIcons();
}

window.toggleListSelectAll = () => { const c=document.getElementById('selectAllList').checked; document.querySelectorAll('.list-check').forEach(cb=>{cb.checked=c; if(c)listSelectedIds.add(cb.value);}); updateListBulkUI(); }
window.toggleListSelection = (id) => { if(listSelectedIds.has(id)) listSelectedIds.delete(id); else listSelectedIds.add(id); updateListBulkUI(); }
function updateListBulkUI() { const b=document.getElementById('bulkActionBar'); if(listSelectedIds.size>0){b.classList.remove('d-none');document.getElementById('listSelectedCount').innerText=listSelectedIds.size;}else{b.classList.add('d-none');} }

window.openListBulkEditModal = () => { document.getElementById('listEditCount').innerText=listSelectedIds.size; document.getElementById('leStart').value=""; document.getElementById('leEnd').value=""; listEditModal.show(); }

// 🟢 SECURE: Bulk Edit Time
window.submitListEdit = async () => { 
    const s=document.getElementById('leStart').value, e=document.getElementById('leEnd').value; 
    if(!s||!e) return showStatusAlert('statusMessage', 'Enter time', false); 
    
    document.getElementById('btnSubmitListEdit').disabled = true;
    showLoading();

    try {
        const b=writeBatch(db); 
        let editCount = 0;
        
        listSelectedIds.forEach(id=>{ 
            const sh=rawSchedules.find(x=>x.id===id); 
            if(sh && !sh.clockIn){ 
                const st=new Date(`${sh.date}T${s}`), et=new Date(`${sh.date}T${e}`); 
                b.update(doc(db,"schedules",id),{start:Timestamp.fromDate(st),end:Timestamp.fromDate(et)}); 
                editCount++;
            } 
        }); 
        
        await b.commit(); 
        
        if (editCount > 0) {
            logAdminAction(db, auth.currentUser, "BULK_EDIT_SHIFTS", "MULTIPLE", { count: editCount }, { newStart: s, newEnd: e });
        }
        
        listEditModal.hide(); 
        hideLoading();
        showStatusAlert('statusMessage', `Updated ${editCount} shifts successfully.`, true);
    } catch(err) {
        hideLoading();
        showStatusAlert('statusMessage', `Edit failed: ${err.message}`, false);
    } finally {
        document.getElementById('btnSubmitListEdit').disabled = false;
    }
}

window.filterTable = () => { const t=document.getElementById('searchInput').value.toLowerCase(), d=document.getElementById('searchDate').value; renderListView(rawSchedules.filter(i=>i.empName.toLowerCase().includes(t)&&(d?i.date===d:true))); }
window.clearFilters = () => { document.getElementById('searchInput').value=''; document.getElementById('searchDate').value=''; renderListView(rawSchedules); }

function initFilters() { const t=new Date(); document.getElementById('filterMonth').value=t.toISOString().slice(0,7); const y=document.getElementById('filterYear'); const c=t.getFullYear(); for(let i=c-2;i<=c+2;i++) y.appendChild(new Option(i,i,false,i===c)); }
window.updateFilterUI = () => { const t=document.getElementById('filterType').value; ['filterMonth','filterWeek','filterYear'].forEach(i=>document.getElementById(i).classList.add('d-none')); if(t==='month')document.getElementById('filterMonth').classList.remove('d-none'); if(t==='week')document.getElementById('filterWeek').classList.remove('d-none'); if(t==='year')document.getElementById('filterYear').classList.remove('d-none'); window.renderAnalytics(); }

window.renderAnalytics = () => { 
    const c=document.getElementById('analyticsList'), t=document.getElementById('filterType').value; 
    let sF, eF; 
    if (t==='month') { const v=document.getElementById('filterMonth').value; if(v) { sF=new Date(v+"-01"); eF=new Date(sF.getFullYear(), sF.getMonth()+1, 0); eF.setHours(23, 59, 59, 999); } } 
    else if (t==='year') { const v=document.getElementById('filterYear').value; if(v) { sF=new Date(v,0,1); eF=new Date(v,11,31); eF.setHours(23, 59, 59, 999); } } 
    else if (t==='week') { const v=document.getElementById('filterWeek').value; if(v) { const [y,w]=v.split('-W'); const s=new Date(y,0,1+(w-1)*7); const d=s.getDay(); const st=s; if(d<=4) st.setDate(s.getDate()-s.getDay()+1); else st.setDate(s.getDate()+8-s.getDay()); sF=st; eF=new Date(st); eF.setDate(eF.getDate()+6); eF.setHours(23, 59, 59, 999); } } 
    
    if(!sF||isNaN(sF)) return c.innerHTML='<div class="text-center text-muted small py-4">Invalid Date.</div>'; 
    const stats={}; 
    rawSchedules.forEach(s=>{ 
        const sd=new Date(s.date); 
        if(sd>=sF && sd<=eF){ 
            if(!stats[s.userId]) stats[s.userId]={name:s.empName, totalHours:0, distinctDates:new Set(), shifts:[]}; 
            stats[s.userId].totalHours+=s.hours; 
            stats[s.userId].distinctDates.add(s.date); 
            stats[s.userId].shifts.push(s); 
        } 
    }); 
    let html=''; 
    Object.keys(stats).sort((a,b)=>stats[b].totalHours-stats[a].totalHours).forEach(uid=>{ 
        const u=stats[uid]; 
        html+=`<div class="stat-item d-flex justify-content-between align-items-center" onclick="window.openStaffAnalytics('${uid}')"><div class="d-flex align-items-center gap-2"><div class="bg-primary bg-opacity-10 text-primary rounded-circle d-flex align-items-center justify-content-center fw-bold" style="width:30px; height:30px; font-size:0.75rem;">${u.name.charAt(0)}</div><div><div class="text-dark small fw-bold">${u.name}</div><div class="stat-label">Workload</div></div></div><div class="text-end"><div class="stat-value text-primary">${u.distinctDates.size} <span style="font-size:0.7em; color:#94a3b8;">Days</span></div><div class="stat-value text-secondary" style="font-size:0.85rem;">${u.totalHours.toFixed(1)} <span style="font-size:0.7em; color:#94a3b8;">Hrs</span></div></div></div>`; 
    }); 
    c.innerHTML=html||'<div class="text-center text-muted small py-4">No shifts.</div>'; 
    window.currentStats=stats; 
}

window.openStaffAnalytics = (uid) => {
    const data = window.currentStats[uid]; if(!data) return;
    document.getElementById('analyticsName').innerText = data.name; document.getElementById('analyticsPeriod').innerText = "Selected Period";
    const t = document.getElementById('staffShiftsBody'); t.innerHTML = '';
    data.shifts.sort((a,b) => new Date(a.date) - new Date(b.date));
    data.shifts.forEach(s => { 
        const d = new Date(s.date).toLocaleDateString('en-US', {weekday: 'short'}); 
        t.innerHTML += `<tr><td class="ps-3">${s.date}</td><td><span class="badge bg-light text-dark border">${d}</span></td><td>${formatTime(s.start)} - ${formatTime(s.end)}</td><td class="text-end pe-3 fw-bold text-primary">${s.hours.toFixed(1)}</td></tr>`; 
    });
    document.getElementById('modalTotalShifts').innerText = data.shifts.length; document.getElementById('modalTotalHours').innerText = data.totalHours.toFixed(1);
    staffAnalyticsModal.show();
}