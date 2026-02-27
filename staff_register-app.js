import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";
import { requireAdmin } from "./auth-guard.js";

// 🟢 导入 utils 的公用方法
import { normalizeDate, formatMalaysianPhone, logAdminAction, showLoading, hideLoading, showStatusAlert } from "./utils.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let excelData = [];
let empModal;

requireAdmin(app, db, async (user) => {
    if (typeof bootstrap !== 'undefined') {
        empModal = new bootstrap.Modal(document.getElementById('employeeModal'));
    }
    
    const joinDateInput = document.getElementById('Join Date');
    if (joinDateInput && !joinDateInput.value) {
        joinDateInput.value = new Date().toISOString().split('T')[0];
    }
    
    hideLoading(); // 🟢 移除初始验证的遮罩层
    document.getElementById('mainContainer').classList.remove('d-none');
    lucide.createIcons();
});

// --- Excel Upload Handling ---
document.getElementById('excelUpload').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        excelData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        renderModalTable(excelData);
        if (empModal) empModal.show();
        e.target.value = '';
    };
    reader.readAsArrayBuffer(file);
});

function renderModalTable(data) {
    document.getElementById('employeeListTable').innerHTML = data.map((row, i) => `
        <tr onclick="window.selectEmployee(${i})">
            <td class="fw-bold">${row['Employee Code'] || '-'}</td>
            <td>${row['Employee Name'] || '-'}</td>
            <td><span class="badge bg-light text-dark border">${row['Department Code'] || '-'}</span></td>
            <td class="text-end"><button class="btn btn-xs btn-outline-primary py-0">Load</button></td>
        </tr>`).join('');
}

window.filterModalTable = function() {
    const filter = document.getElementById('modalSearch').value.toUpperCase();
    const rows = document.getElementById('employeeListTable').getElementsByTagName('tr');
    for (let row of rows) {
        row.style.display = row.textContent.toUpperCase().includes(filter) ? "" : "none";
    }
};

window.selectEmployee = function(index) {
    const data = excelData[index];
    Object.keys(data).forEach(key => {
        const el = document.getElementById(key);
        if(el) window.setVal(el, data[key]);
    });

    const headerMap = {
        'GIRO 1 Bank Name': 'bank_name_1', 'GIRO 1 Branch ID': 'branch_id_1', 'GIRO 1 A/C No': 'acc_no_1', 'GIRO 1 Percentage': 'pct_1', 'GIRO 1 Cheque Percentage': 'chq_pct_1',
        'GIRO 2 Bank Name': 'bank_name_2', 'GIRO 2 Branch ID': 'branch_id_2', 'GIRO 2 A/C No': 'acc_no_2', 'GIRO 2 Percentage': 'pct_2', 'GIRO 2 Cheque Percentage': 'chq_pct_2'
    };

    Object.keys(headerMap).forEach(excelKey => {
        const htmlId = headerMap[excelKey];
        if(data[excelKey] !== undefined) {
            const el = document.getElementById(htmlId);
            if(el) window.setVal(el, data[excelKey]);
        }
    });

    const childBody = document.getElementById('childrenBody');
    childBody.innerHTML = '';
    for(let i=1; i<=6; i++) {
        const name = data[`Child ${i} Name`];
        if(name) {
            const isMy = data[`Child ${i} Is Malaysian`] === 'YES' || data[`Child ${i} Is Malaysian`] === 1;
            childBody.appendChild(createChildRow(name, window.formatExcelDate(data[`Child ${i} DOB`]), data[`Child ${i} Gender`], data[`Child ${i} Birth Certificate No.`], isMy, data[`Child ${i} TAX Category`], data[`Child ${i} TAX Percentage`]));
        }
    }
    lucide.createIcons();
    window.syncBio();
    if (empModal) empModal.hide();
};

// --- Firebase Write Logic ---
document.getElementById('btnSubmitFirebase').addEventListener('click', async () => {
    const getVal = (id) => {
        const el = document.getElementById(id);
        if (!el) return '';
        return el.type === 'checkbox' ? el.checked : el.value;
    };

    const empCode = getVal('Employee Code');
    const emailInput = getVal('Email Address');

    if (!empCode || !emailInput) {
        showStatusAlert('statusMessage', "Error: Employee Code and Email Address are required.", false); // 🟢
        return;
    }

    showLoading(); // 🟢

    try {
        const docRef = doc(db, "users", empCode);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            hideLoading(); // 🟢
            showStatusAlert('statusMessage', `Error: Code '${empCode}' already exists.`, false); // 🟢
            return;
        }

        const formattedEmail = emailInput.toLowerCase().trim();
        const formattedPhone = formatMalaysianPhone(getVal('Mobile Number'));

        // Duplicate checks
        const duplicateCheck = await getDocs(query(collection(db, "users"), where("personal.email", "==", formattedEmail)));
        if (!duplicateCheck.empty) {
            hideLoading(); // 🟢
            showStatusAlert('statusMessage', "Error: Email is already in use.", false); // 🟢
            return;
        }

        const formData = {
            authUid: null,
            role: "staff",
            status: "active",
            isDriver: getVal('isDriver'),
            meta: { updatedAt: new Date(), isPreRegistered: true, docVersion: "v2.0" },
            personal: {
                empCode, name: getVal('Employee Name'), shortName: getVal('Short Name'), bioId: getVal('Finger Print/Face ID'),
                dob: getVal('Birth Date'), gender: getVal('Gender'), marital: getVal('Marital Status'), email: formattedEmail, mobile: formattedPhone,
                icNo: getVal('MYKAD/IC (Malaysian or PR)'), oldIc: getVal('Old Ic No'), nationality: getVal('Nationality'), race: getVal('Race'), religion: getVal('Religion'), empType: getVal('Employment Type'), blood: getVal('Blood Type')
            },
            employment: {
                joinDate: getVal('Join Date'), probation: getVal('Probation (Months)'), confirmDate: getVal('Confirmation Date'), termDate: getVal('Termination Date'), contractEnd: getVal('End of Contract Date'),
                dept: getVal('Department Code'), section: getVal('Section Code'), designation: getVal('Designation Code'), desigGroup: getVal('Desig Group Code'), category: getVal('Category Code'), status: getVal('Employee Status'),
                holidayGrp: getVal('Holiday Group Code'), leaveCat: getVal('Leave Category Code'), shift: getVal('Working Hours/Shift'), excludeDays: getVal('Exclude Days'), hrsDay: getVal('Hours Worked /Day'), daysWeek: getVal('Days Worked /Week'), hrsWeek: getVal('Hours Worked Per Week'), isPartTime: getVal('Part Time'), isFlexi: getVal('Flexi Hours')
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
            }
        };

        await setDoc(doc(db, "users", empCode), formData);
        
        await logAdminAction(db, auth.currentUser, "REGISTER_NEW_STAFF", empCode, null, { name: formData.personal.name, email: formData.personal.email });

        hideLoading(); // 🟢
        showStatusAlert('statusMessage', "✅ Staff Successfully Added!", true); // 🟢
        setTimeout(() => { window.location.reload(); }, 1500);
        
    } catch (e) { 
        hideLoading(); // 🟢
        showStatusAlert('statusMessage', "Save Error: " + e.message, false); // 🟢
    } 
});

// --- Helpers ---
window.setVal = (el, val) => {
    if(el.type === 'checkbox') el.checked = (val === 'YES' || val === true);
    else if(el.type === 'date') el.value = window.formatExcelDate(val);
    else el.value = val;
};

function createChildRow(name, dob, gender, cert, isMy, taxCat, taxPct) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="text" class="form-control form-control-sm" value="${name || ''}"></td>
        <td><input type="date" class="form-control form-control-sm" value="${dob || ''}"></td>
        <td><select class="form-select form-select-sm"><option value="MALE" ${gender==='MALE'?'selected':''}>Male</option><option value="FEMALE" ${gender==='FEMALE'?'selected':''}>Female</option></select></td>
        <td><input type="text" class="form-control form-control-sm" value="${cert || ''}"></td>
        <td class="text-center"><input type="checkbox" class="form-check-input" ${isMy?'checked':''}></td>
        <td><input type="text" class="form-control form-control-sm" value="${taxCat || ''}"></td>
        <td><input type="number" class="form-control form-control-sm" value="${taxPct || ''}"></td>
        <td class="text-center"><button type="button" class="btn btn-sm text-danger border-0 p-0" onclick="this.closest('tr').remove()"><i data-lucide="trash-2" class="size-4"></i></button></td>`;
    return tr;
}

window.scrapeChildrenData = () => {
    const children = [];
    document.querySelectorAll('#childrenBody tr').forEach(row => {
        const inputs = row.querySelectorAll('input, select');
        if(inputs[0].value) {
            children.push({ name: inputs[0].value, dob: inputs[1].value, gender: inputs[2].value, cert: inputs[3].value, isMalaysian: inputs[4].checked, taxCat: inputs[5].value, taxPct: inputs[6].value });
        }
    });
    return children;
};

window.addChildRow = () => { document.getElementById('childrenBody').appendChild(createChildRow('','','','',false,'','')); lucide.createIcons(); };

window.formatExcelDate = (val) => {
    if(!val) return '';
    if(typeof val === 'number') return new Date((val - 25569)*86400*1000).toISOString().split('T')[0];
    try { return new Date(val).toISOString().split('T')[0]; } catch(e){ return val; }
};

window.syncBio = () => { document.getElementById('Finger Print/Face ID').value = document.getElementById('Employee Code').value; };