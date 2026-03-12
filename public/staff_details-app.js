import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, getDoc, updateDoc, collection, query, where, getDocs, deleteField, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";
import { requireAdmin } from "./auth-guard.js";

// 🟢 1. 引入 utils.js 中的所有所需函数
import { formatMalaysianPhone, normalizeDate, logAdminAction, showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

(function(){ emailjs.init("yTP2W2IzGSKqHDqWa"); })();

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
let currentUserData = null; 

const urlParams = new URLSearchParams(window.location.search);
const uid = urlParams.get('uid');

requireAdmin(app, db, async (user, userData) => {
    document.getElementById('loadingText').innerText = "Loading Profile...";
    if(uid) loadUserData(uid);
    else { 
        // 如果没有 UID，不应该用 alert，直接跳转
        window.location.href="manage_staff.html"; 
    }
});

const setVal = (id, val) => {
    const el = document.getElementById(id);
    if(!el) return;
    if(el.type === 'checkbox') el.checked = (val === true || val === 'YES');
    // 🟢 2. 使用 utils 中的 normalizeDate
    else if(el.type === 'date' && val) el.value = normalizeDate(val);
    else el.value = val || '';
};

const getVal = (id) => {
    const el = document.getElementById(id);
    if(!el) return '';
    if(el.type === 'checkbox') return el.checked;
    return el.value;
};

window.createChildRow = function(name, dob, gender, cert, isMy, taxCat, taxPct) {
    const tr = document.createElement('tr');
    // 🟢 使用 normalizeDate 确保日期格式正确
    tr.innerHTML = `
        <td><input type="text" class="form-control form-control-sm" value="${name || ''}"></td>
        <td><input type="date" class="form-control form-control-sm" value="${normalizeDate(dob) || ''}"></td>
        <td><select class="form-select form-select-sm"><option value="MALE" ${gender==='MALE'?'selected':''} >Male</option><option value="FEMALE" ${gender==='FEMALE'?'selected':''}>Female</option></select></td>
        <td><input type="text" class="form-control form-control-sm" value="${cert || ''}"></td>
        <td class="text-center"><input type="checkbox" class="form-check-input" ${isMy?'checked':''}></td>
        <td><input type="text" class="form-control form-control-sm" value="${taxCat || ''}"></td>
        <td><input type="number" class="form-control form-control-sm" value="${taxPct || ''}"></td>
        <td class="text-center"><button type="button" class="btn btn-sm text-danger border-0 p-0" onclick="this.closest('tr').remove()"><i data-lucide="trash-2" class="size-4"></i></button></td>
    `;
    return tr;
};

window.addChildRow = function() {
    document.getElementById('childrenBody').appendChild(window.createChildRow('','','','',false,'',''));
    lucide.createIcons();
};

window.scrapeChildrenData = function() {
    const children = [];
    document.querySelectorAll('#childrenBody tr').forEach(row => {
        const inputs = row.querySelectorAll('input, select');
        if(inputs[0].value) { 
            children.push({
                name: inputs[0].value, dob: inputs[1].value, gender: inputs[2].value, cert: inputs[3].value,
                isMalaysian: inputs[4].checked, taxCat: inputs[5].value, taxPct: inputs[6].value
            });
        }
    });
    return children;
};

const toggleFormState = (status) => {
    const isEditable = (status === 'editable');
    document.querySelectorAll('#masterForm input, #masterForm select, #masterForm textarea, #masterForm button').forEach(input => {
        if(['Employee Code', 'Finger Print/Face ID'].includes(input.id)) input.disabled = true; 
        else input.disabled = !isEditable;
    });
    document.getElementById('btnSaveChanges').disabled = !isEditable;
    const select = document.getElementById('statusSelect');
    select.value = status === 'editable' ? 'editable' : (status === 'disabled' ? 'disabled' : 'active');
    select.className = `form-select form-select-sm border-2 fw-bold ${status==='editable'?'border-warning text-warning':(status==='disabled'?'border-danger text-danger':'border-success text-success')}`;
};

async function loadUserData(userId) {
    try {
        const docSnap = await getDoc(doc(db, "users", userId));
        if (docSnap.exists()) {
            const data = docSnap.data();
            currentUserData = data; 
            if (data.status === 'editable' && data.unlockExpiresAt && new Date() > data.unlockExpiresAt.toDate()) {
                await updateDoc(doc(db, "users", userId), { status: 'active', unlockExpiresAt: null });
                data.status = 'active';
            }
            document.getElementById('headerName').innerText = data.personal?.name || "Unknown";
            document.getElementById('headerCode').innerText = `EMP ID: ${data.personal?.empCode}`;
            
            // Map fields
            if(data.personal){
                const p = data.personal;
                setVal('Employee Code', p.empCode); setVal('Employee Name', p.name); setVal('Short Name', p.shortName);
                setVal('Finger Print/Face ID', p.bioId); setVal('MYKAD/IC (Malaysian or PR)', p.icNo); setVal('Old Ic No', p.oldIc);
                setVal('Birth Date', p.dob); setVal('Gender', p.gender); setVal('Marital Status', p.marital);
                setVal('Nationality', p.nationality); setVal('Race', p.race); setVal('Religion', p.religion);
                setVal('Employment Type', p.empType); setVal('Blood Type', p.blood); setVal('Email Address', p.email); setVal('Mobile Number', p.mobile);
            }
            if(data.foreign){
                const f = data.foreign;
                setVal('Foreign ID No', f.id); setVal('Passport No', f.passport); setVal('Passport Expiry Date', f.passportExp);
                setVal('Pass Expiry Date', f.passExp); setVal('Arrival Date', f.arrival); setVal('FOMEMA Expiry Date', f.fomema); setVal('Issue Date', f.issue);
            }
            if(data.employment){
                const e = data.employment;
                setVal('Join Date', e.joinDate); setVal('Probation (Months)', e.probation); setVal('Confirmation Date', e.confirmDate);
                setVal('Termination Date', e.termDate); setVal('End of Contract Date', e.contractEnd); setVal('Department Code', e.dept);
                setVal('Section Code', e.section); setVal('Designation Code', e.designation); setVal('Desig Group Code', e.desigGroup);
                setVal('Category Code', e.category); setVal('Employee Status', e.status); setVal('Holiday Group Code', e.holidayGrp);
                setVal('Leave Category Code', e.leaveCat); setVal('Working Hours/Shift', e.shift); setVal('Exclude Days', e.excludeDays);
                setVal('Hours Worked /Day', e.hrsDay); setVal('Days Worked /Week', e.daysWeek); setVal('Hours Worked Per Week', e.hrsWeek);
                setVal('Part Time', e.isPartTime); setVal('Flexi Hours', e.isFlexi);
            }
            if(data.statutory){
                const s = data.statutory;
                setVal('EPF Category', s.epf?.cat); setVal('EPF Number', s.epf?.no); setVal('EPF Emp Name', s.epf?.name); setVal('Employer EPF No', s.epf?.employerNo); setVal('EPF Contribution', s.epf?.contrib);
                setVal('SOCSO Category', s.socso?.cat); setVal('SOCSO Security No', s.socso?.no); setVal('Employer SOCSO No', s.socso?.employerNo); setVal('EIS Contribution', s.eis);
                setVal('INCOME TAX NO', s.tax?.no); setVal('TAX Resident Status', s.tax?.resStatus); setVal('TAX Resident Type', s.tax?.resType);
                setVal('Tax Disable Person', s.tax?.disable); setVal('Tax Spouse Status', s.tax?.spouseStatus); setVal('Tax Spouse Disabled', s.tax?.spouseDisable);
                setVal('PTPTN Acc No', s.ptptn); setVal('Zakat Acc No', s.zakat); setVal('Employer HRDF No', s.hrdf);
            }
            if(data.payroll){
                const pr = data.payroll;
                setVal('Basic Salary', pr.basic); setVal('Pay Day Group', pr.payGroup); setVal('Daily Rate Code', pr.dailyRateCode); setVal('Paid Type', pr.paidType);
                setVal('OT Type', pr.ot?.type); setVal('Flat/Hourly Rate', pr.ot?.rate);
                setVal('Multiple Pay %', pr.split?.multiPayPct); setVal('Multiple Pay Fixed Amt', pr.split?.multiPayFixed); setVal('Cash Percentage', pr.split?.cashPct);
                setVal('bank_name_1', pr.bank1?.name); setVal('branch_id_1', pr.bank1?.branch); setVal('acc_no_1', pr.bank1?.acc); setVal('pct_1', pr.bank1?.pct); setVal('chq_pct_1', pr.bank1?.chq);
                setVal('bank_name_2', pr.bank2?.name); setVal('branch_id_2', pr.bank2?.branch); setVal('acc_no_2', pr.bank2?.acc); setVal('pct_2', pr.bank2?.pct); setVal('chq_pct_2', pr.bank2?.chq);
            }
            if(data.address){
                const a = data.address;
                setVal('Local Address Door No', a.local?.door); setVal('Local Address Location', a.local?.loc); setVal('Local Address Street', a.local?.street);
                setVal('Local Address City', a.local?.city); setVal('Local Address State', a.local?.state); setVal('Local Address Country', a.local?.country); setVal('Local Address Pincode', a.local?.pin);
                setVal('Foreign Address Door No', a.foreign?.door); setVal('Foreign Address Location', a.foreign?.loc); setVal('Foreign Address Street', a.foreign?.street);
                setVal('Foreign Address City', a.foreign?.city); setVal('Foreign Address State', a.foreign?.state); setVal('Foreign Address Country', a.foreign?.country); setVal('Foreign Address Pincode', a.foreign?.pin);
                setVal('Emergency Contact Person', a.emergency?.name); setVal('Emergency Contact Relationship', a.emergency?.rel); setVal('Emergency Contact Number', a.emergency?.no); setVal('Emergency Contact MYKAD/IC OR Passport No', a.emergency?.id);
            }
            if(data.family?.children){
                const cb = document.getElementById('childrenBody'); cb.innerHTML = '';
                data.family.children.forEach(c => cb.appendChild(window.createChildRow(c.name, c.dob, c.gender, c.cert, c.isMalaysian, c.taxCat, c.taxPct)));
            }

            toggleFormState(data.status || 'editable');
            
            // 🟢 3. 使用 utils 隐藏加载层
            hideLoading(); 
            document.getElementById('mainContainer').classList.remove('d-none');
            lucide.createIcons();
        } else { 
            showStatusAlert('statusMessage', 'User not found!', false);
            setTimeout(() => window.location.href = "manage_staff.html", 1500); 
        }
    } catch (error) { 
        hideLoading();
        showStatusAlert('statusMessage', "Error loading profile: " + error.message, false); 
    }
}

document.getElementById('btnUpdateStatus').addEventListener('click', async () => {
    const newStatus = document.getElementById('statusSelect').value;
    const btn = document.getElementById('btnUpdateStatus');
    btn.disabled = true;
    try {
        const oldStatus = currentUserData.status;
        let updateData = { status: newStatus, unlockExpiresAt: newStatus === 'editable' ? new Date(Date.now() + 5 * 60 * 1000) : null };
        await updateDoc(doc(db, "users", uid), updateData);
        
        // 记录日志
        await logAdminAction(db, auth.currentUser, "UPDATE_USER_STATUS", uid, { status: oldStatus }, { status: newStatus });
        
        toggleFormState(newStatus);
        
        // 🟢 4. 优雅的 Toast 提示
        showStatusAlert('statusMessage', `Status updated to: ${newStatus.toUpperCase()}`, true);
    } catch (e) { 
        showStatusAlert('statusMessage', "Error updating status: " + e.message, false); 
    } finally { 
        btn.disabled = false; 
        lucide.createIcons(); 
    }
});

document.getElementById('btnSaveChanges').addEventListener('click', async () => {
    const email = getVal('Email Address').toLowerCase().trim();
    // 🟢 使用 utils 中的电话格式化
    const phone = formatMalaysianPhone(getVal('Mobile Number'));
    
    // 🟢 使用 utils 开启加载层
    document.getElementById('loadingText').innerText = "Saving Changes...";
    showLoading();
    
    try {
        // Duplicate Checks
        const checks = [
            { val: getVal('MYKAD/IC (Malaysian or PR)'), field: 'personal.icNo', label: 'IC Number' },
            { val: email, field: 'personal.email', label: 'Email' },
            { val: phone, field: 'personal.mobile', label: 'Mobile' }
        ];
        for (const c of checks) {
            if (!c.val) continue;
            const snap = await getDocs(query(collection(db, "users"), where(c.field, "==", c.val)));
            if (snap.docs.some(d => d.id !== uid)) {
                hideLoading();
                showStatusAlert('statusMessage', `Duplicate Data: ${c.label} already exists.`, false);
                return;
            }
        }

        let requiresReset = false;
        if (currentUserData.authUid && (email !== currentUserData.personal?.email || phone !== formatMalaysianPhone(currentUserData.personal?.mobile))) {
            if (!confirm("Changing Email/Phone will reset the staff's App access. Proceed?")) { 
                hideLoading(); 
                return; 
            }
            requiresReset = true;
        }

        const formData = {
            personal: {
                empCode: getVal('Employee Code'), name: getVal('Employee Name'), shortName: getVal('Short Name'),
                icNo: getVal('MYKAD/IC (Malaysian or PR)'), oldIc: getVal('Old Ic No'), dob: getVal('Birth Date'),
                gender: getVal('Gender'), marital: getVal('Marital Status'), email: email, mobile: phone,
                nationality: getVal('Nationality'), race: getVal('Race'), religion: getVal('Religion'), empType: getVal('Employment Type'), blood: getVal('Blood Type'), bioId: getVal('Finger Print/Face ID')
            },
            foreign: {
                id: getVal('Foreign ID No'), passport: getVal('Passport No'), passportExp: getVal('Passport Expiry Date'),
                passExp: getVal('Pass Expiry Date'), arrival: getVal('Arrival Date'), fomema: getVal('FOMEMA Expiry Date'), issue: getVal('Issue Date')
            },
            employment: {
                joinDate: getVal('Join Date'), probation: getVal('Probation (Months)'), confirmDate: getVal('Confirmation Date'),
                termDate: getVal('Termination Date'), contractEnd: getVal('End of Contract Date'), dept: getVal('Department Code'),
                section: getVal('Section Code'), designation: getVal('Designation Code'), desigGroup: getVal('Desig Group Code'),
                category: getVal('Category Code'), status: getVal('Employee Status'), holidayGrp: getVal('Holiday Group Code'),
                leaveCat: getVal('Leave Category Code'), shift: getVal('Working Hours/Shift'), excludeDays: getVal('Exclude Days'),
                hrsDay: getVal('Hours Worked /Day'), daysWeek: getVal('Days Worked /Week'), hrsWeek: getVal('Hours Worked Per Week'),
                isPartTime: getVal('Part Time'), isFlexi: getVal('Flexi Hours')
            },
            statutory: {
                epf: { cat: getVal('EPF Category'), no: getVal('EPF Number'), name: getVal('EPF Emp Name'), employerNo: getVal('Employer EPF No'), contrib: getVal('EPF Contribution') },
                socso: { cat: getVal('SOCSO Category'), no: getVal('SOCSO Security No'), employerNo: getVal('Employer SOCSO No') },
                tax: { no: getVal('INCOME TAX NO'), resStatus: getVal('TAX Resident Status'), resType: getVal('TAX Resident Type'), disable: getVal('Tax Disable Person'), spouseStatus: getVal('Tax Spouse Status'), spouseDisable: getVal('Tax Spouse Disabled') },
                eis: getVal('EIS Contribution'), ptptn: getVal('PTPTN Acc No'), zakat: getVal('Zakat Acc No'), hrdf: getVal('Employer HRDF No')
            },
            payroll: {
                basic: getVal('Basic Salary'), payGroup: getVal('Pay Day Group'), dailyRateCode: getVal('Daily Rate Code'), paidType: getVal('Paid Type'),
                ot: { type: getVal('OT Type'), rate: getVal('Flat/Hourly Rate') },
                split: { multiPayPct: getVal('Multiple Pay %'), multiPayFixed: getVal('Multiple Pay Fixed Amt'), cashPct: getVal('Cash Percentage') },
                bank1: { name: getVal('bank_name_1'), branch: getVal('branch_id_1'), acc: getVal('acc_no_1'), pct: getVal('pct_1'), chq: getVal('chq_pct_1') },
                bank2: { name: getVal('bank_name_2'), branch: getVal('branch_id_2'), acc: getVal('acc_no_2'), pct: getVal('pct_2'), chq: getVal('chq_pct_2') }
            },
            address: {
                local: { door: getVal('Local Address Door No'), loc: getVal('Local Address Location'), street: getVal('Local Address Street'), city: getVal('Local Address City'), state: getVal('Local Address State'), country: getVal('Local Address Country'), pin: getVal('Local Address Pincode') },
                foreign: { door: getVal('Foreign Address Door No'), loc: getVal('Foreign Address Location'), street: getVal('Foreign Address Street'), city: getVal('Foreign Address City'), state: getVal('Foreign Address State'), country: getVal('Foreign Address Country'), pin: getVal('Foreign Address Pincode') },
                emergency: { name: getVal('Emergency Contact Person'), rel: getVal('Emergency Contact Relationship'), no: getVal('Emergency Contact Number'), id: getVal('Emergency Contact MYKAD/IC OR Passport No') }
            },
            family: {
                spouse: { name: getVal('Spouse Name'), id: getVal('Spouse MyKad/Passport'), phone: getVal('Spouse Phone'), job: getVal('Spouse Occupation'), dob: getVal('Spouse DOB') },
                children: window.scrapeChildrenData()
            },
            "meta.updatedAt": serverTimestamp()
        };

        if (requiresReset) {
            formData.authUid = deleteField();
            formData.status = 'inactive';
            if (currentUserData.personal?.email) {
                emailjs.send("service_p0fxt7y", "template_good5a6", { 
                    user_name: getVal('Employee Name'), 
                    to_email: currentUserData.personal.email 
                });
            }
        }

        await updateDoc(doc(db, "users", uid), formData);
        
        // 记录日志
        await logAdminAction(db, auth.currentUser, "UPDATE_STAFF_PROFILE", uid, currentUserData, formData);
        
        hideLoading();
        showStatusAlert('statusMessage', "Staff details updated successfully!", true);
        
        // 稍微延迟刷新，让用户能看到成功提示
        setTimeout(() => {
            location.reload();
        }, 1000);
        
    } catch(e) { 
        hideLoading();
        showStatusAlert('statusMessage', "Save error: " + e.message, false); 
    }
});