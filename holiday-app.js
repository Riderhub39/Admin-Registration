// holiday-app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, doc, getDoc, updateDoc, arrayUnion, arrayRemove, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// 🟢 导入通用 UI 和日志函数
import { logAdminAction, showLoading, hideLoading, showStatusAlert } from "./utils.js"; 

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app); 
const holidayDocRef = doc(db, "settings", "holidays");

export async function initHolidayApp() {
    document.getElementById('loadingText').innerText = "Loading Holidays...";
    await loadHolidays(); 
    
    // 🟢 加载完成后隐藏全局遮罩
    hideLoading();
    document.getElementById('mainContainer').classList.remove('d-none');
    lucide.createIcons();
}

async function loadHolidays() {
    const listDiv = document.getElementById('holidayList');
    try {
        const docSnap = await getDoc(holidayDocRef);
        if (docSnap.exists()) {
            const list = docSnap.data().holiday_list || [];
            
            if (list.length === 0) {
                listDiv.innerHTML = "<div class='text-center py-3 text-muted small'>No holidays found.</div>";
                return;
            }

            list.sort((a,b) => a.date.localeCompare(b.date));

            listDiv.innerHTML = list.map(h => `
                <div class="list-group-item d-flex justify-content-between align-items-center">
                    <div>
                        <div class="fw-bold text-dark">${h.name}</div>
                        <div class="text-muted small"><i data-lucide="calendar" class="size-3 me-1"></i>${h.date}</div>
                    </div>
                    <button class="btn btn-sm btn-outline-danger border-0" onclick="window.deleteHoliday('${h.name}', '${h.date}')">
                        <i data-lucide="trash-2" class="size-4"></i>
                    </button>
                </div>
            `).join('');
            
            lucide.createIcons();
        } else {
            listDiv.innerHTML = "<div class='text-center py-3 text-muted small'>No holidays configured yet.</div>";
        }
    } catch (e) {
        listDiv.innerHTML = `<div class='text-center py-3 text-danger small'>Error: ${e.message}</div>`;
    }
}

// 🟢 使用全局提示和 Loading
window.addHoliday = async function() {
    const name = document.getElementById('hName').value.trim();
    const date = document.getElementById('hDate').value;

    if(!name || !date) { 
        showStatusAlert('statusMessage', "Please enter a name and date.", false); 
        return; 
    }

    showLoading(); // 🟢

    try {
        const docSnap = await getDoc(holidayDocRef);
        const holidayObj = { name: name, date: date };

        if (!docSnap.exists()) {
            await setDoc(holidayDocRef, { holiday_list: [holidayObj] });
        } else {
            await updateDoc(holidayDocRef, {
                holiday_list: arrayUnion(holidayObj)
            });
        }
        
        await logAdminAction(db, auth.currentUser, "ADD_HOLIDAY", "GLOBAL", null, holidayObj);

        document.getElementById('hName').value = "";
        document.getElementById('hDate').value = "";
        
        await loadHolidays(); 
        
        hideLoading(); // 🟢
        showStatusAlert('statusMessage', "Holiday saved successfully!", true);
    } catch (e) {
        hideLoading(); // 🟢
        showStatusAlert('statusMessage', `Error: ${e.message}`, false);
        console.error(e);
    }
}

// 🟢 使用全局提示和 Loading
window.deleteHoliday = async function(name, date) {
    if(!confirm(`Remove ${name}?`)) return;
    
    showLoading(); // 🟢
    try {
        const holidayObj = { name: name, date: date };
        
        await updateDoc(holidayDocRef, {
            holiday_list: arrayRemove(holidayObj)
        });

        await logAdminAction(db, auth.currentUser, "REMOVE_HOLIDAY", "GLOBAL", holidayObj, null);

        await loadHolidays();
        
        hideLoading(); // 🟢
        showStatusAlert('statusMessage', "Holiday removed.", true);
    } catch (e) { 
        hideLoading(); // 🟢
        showStatusAlert('statusMessage', `Error: ${e.message}`, false); 
    }
}