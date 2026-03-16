// 文件: evidence-gallery-app.js
import { collection, query, where, getDocs, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let db; // 声明内部数据库实例变量
let imageModal;
let dateInput;

// 初始化函数：供 HTML 验证身份后调用，并接收 db 实例
export async function initEvidenceGalleryApp(dbInstance) {
    db = dbInstance; // 赋值传入的数据库实例

    document.getElementById('loadingText').innerText = "Loading Gallery...";
    imageModal = new bootstrap.Modal(document.getElementById('imageModal'));
    
    dateInput = document.getElementById('dateFilter');
    dateInput.value = new Date().toISOString().split('T')[0];
    
    await loadStaffList();
    loadEvidenceImpl(); 
    
    document.getElementById('loadingOverlay').style.display = 'none';
    document.getElementById('mainContainer').classList.remove('d-none');
    lucide.createIcons();
}

async function loadStaffList() {
    const select = document.getElementById('staffFilter');
    try {
        const q = query(collection(db, "users"), where("role", "==", "staff"));
        const snap = await getDocs(q);
        snap.forEach(doc => {
            const d = doc.data();
            if (d.status === 'disabled') return;
            const name = d.personal?.name || d.name || "Unknown";
            const opt = document.createElement('option');
            opt.value = d.authUid || doc.id; 
            opt.textContent = name;
            select.appendChild(opt);
        });
    } catch (e) {
        console.error("Error loading staff:", e);
    }
}

async function loadEvidenceImpl() {
    const container = document.getElementById('galleryContainer');
    const dateVal = document.getElementById('dateFilter').value;
    const staffVal = document.getElementById('staffFilter').value;

    container.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';

    try {
        const startDate = new Date(dateVal);
        startDate.setHours(0,0,0,0);
        const endDate = new Date(dateVal);
        endDate.setHours(23, 59, 59, 999);

        let q = query(
            collection(db, "evidence_logs"),
            where("capturedAt", ">=", startDate),
            where("capturedAt", "<=", endDate),
            orderBy("capturedAt", "desc")
        );

        const snap = await getDocs(q);
        
        if (snap.empty) {
            container.innerHTML = `<div class="text-center py-5 text-muted"><i data-lucide="image-off" class="size-12 mb-3"></i><p>No photos found for this date.</p></div>`;
            lucide.createIcons();
            return;
        }

        const grouped = {};
        snap.forEach(doc => {
            const d = doc.data();
            if (staffVal !== 'all' && d.uid !== staffVal) return;

            const sName = d.staffName || "Unknown Staff";
            if (!grouped[sName]) grouped[sName] = [];
            grouped[sName].push({ id: doc.id, ...d });
        });

        if (Object.keys(grouped).length === 0) {
            container.innerHTML = `<div class="text-center py-5 text-muted"><p>No photos found for selected staff.</p></div>`;
            return;
        }

        container.innerHTML = '';
        Object.keys(grouped).forEach(staffName => {
            const photos = grouped[staffName];
            const section = document.createElement('div');
            section.className = 'staff-section';
            
            let photosHtml = '';
            photos.forEach(p => {
                const timeStr = p.localTime ? p.localTime.split(' ')[1] : "Unknown"; 
                const safeData = JSON.stringify(p).replace(/"/g, '&quot;');
                
                photosHtml += `
                    <div class="photo-card" onclick="window.openPhoto(${safeData})">
                        <span class="timestamp-badge">${timeStr}</span>
                        <img src="${p.photoUrl}" class="photo-img" loading="lazy">
                        <div class="photo-info">
                            <div class="location-text">
                                <i data-lucide="map-pin" class="size-3 me-1"></i>${p.location || 'GPS Only'}
                            </div>
                        </div>
                    </div>
                `;
            });

            section.innerHTML = `
                <div class="staff-header">
                    <div class="bg-primary bg-opacity-10 text-primary rounded p-2">
                        <i data-lucide="user" class="size-5"></i>
                    </div>
                    <h6 class="fw-bold m-0 text-dark">${staffName} <span class="text-muted fw-normal">(${photos.length} photos)</span></h6>
                </div>
                <div class="photo-grid">
                    ${photosHtml}
                </div>
            `;
            container.appendChild(section);
        });

        lucide.createIcons();

    } catch (e) {
        console.error(e);
        container.innerHTML = `<div class="alert alert-danger mx-3 mt-3">Error loading evidence: ${e.message}</div>`;
    }
}

// ----------------------------------------------------
// 暴露给 window 供 HTML 中的 onclick / onchange 调用
// ----------------------------------------------------
window.changeDate = (days) => {
    if (!dateInput) return;
    const current = new Date(dateInput.value);
    current.setDate(current.getDate() + days);
    dateInput.value = current.toISOString().split('T')[0];
    loadEvidenceImpl();
};

window.loadEvidence = loadEvidenceImpl;

window.openPhoto = (data) => {
    document.getElementById('modalFullImage').src = data.photoUrl;
    document.getElementById('modalStaffName').innerText = data.staffName;
    document.getElementById('modalTime').innerText = data.localTime;
    document.getElementById('modalLocation').innerText = data.location;
    if (imageModal) imageModal.show();
};