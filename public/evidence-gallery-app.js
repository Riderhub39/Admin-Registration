import { collection, query, where, getDocs, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let db; 
let imageModal;
let dateInput;

// 初始化函数
export async function initEvidenceGalleryApp(dbInstance) {
    db = dbInstance; 

    document.getElementById('loadingText').innerText = "Loading Cases...";
    imageModal = new bootstrap.Modal(document.getElementById('imageModal'));
    
    dateInput = document.getElementById('filterDate');
    dateInput.value = new Date().toISOString().split('T')[0];
    
    loadEvidenceImpl(); 
    
    document.getElementById('loadingOverlay').style.display = 'none';
    document.getElementById('mainContainer').classList.remove('d-none');
    lucide.createIcons();
}

async function loadEvidenceImpl() {
    const container = document.getElementById('galleryContainer');
    
    // 获取检索条件
    const dateVal = document.getElementById('filterDate').value;
    const caseKeyword = document.getElementById('filterCase').value.trim().toLowerCase();
    const clientKeyword = document.getElementById('filterClient').value.trim().toLowerCase();

    container.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';

    try {
        const startDate = new Date(dateVal);
        startDate.setHours(0,0,0,0);
        const endDate = new Date(dateVal);
        endDate.setHours(23, 59, 59, 999);

        // 1. 按照日期从 Firestore 拉取数据
        let q = query(
            collection(db, "evidence_logs"),
            where("capturedAt", ">=", startDate),
            where("capturedAt", "<=", endDate),
            orderBy("capturedAt", "desc")
        );

        const snap = await getDocs(q);
        
        if (snap.empty) {
            container.innerHTML = `<div class="text-center py-5 text-muted"><i data-lucide="folder-open" class="size-12 mb-3"></i><p>No case evidence found for this date.</p></div>`;
            lucide.createIcons();
            return;
        }

        // 2. 🟢 按 Case No 分组，并应用文本过滤
        const grouped = {};
        
        snap.forEach(doc => {
            const d = doc.data();
            const caseNo = d.caseNo || "Unknown Case";
            const clientName = d.clientName || "No Client Specified";
            
            // 文本过滤 (如果不包含关键词，则跳过)
            if (caseKeyword && !caseNo.toLowerCase().includes(caseKeyword)) return;
            if (clientKeyword && !clientName.toLowerCase().includes(clientKeyword)) return;

            if (!grouped[caseNo]) {
                grouped[caseNo] = {
                    clientName: clientName,
                    staffName: d.staffName || "Unknown Staff", // 假设同一个 Case 主要是同一个员工负责
                    photos: []
                };
            }
            grouped[caseNo].photos.push({ id: doc.id, ...d });
        });

        const caseKeys = Object.keys(grouped);
        if (caseKeys.length === 0) {
            container.innerHTML = `<div class="text-center py-5 text-muted"><p>No cases match your search criteria.</p></div>`;
            return;
        }

        // 3. 渲染 UI
        container.innerHTML = '';
        caseKeys.forEach(caseNo => {
            const caseData = grouped[caseNo];
            
            // 复用你 style.css 里的 staff-section 样式，但是展示为 Case 卡片
            const section = document.createElement('div');
            section.className = 'staff-section'; 
            
            let photosHtml = '';
            caseData.photos.forEach(p => {
                const timeStr = p.localTime ? p.localTime.split(' ')[1] : "Unknown"; 
                const safeData = JSON.stringify(p).replace(/"/g, '&quot;');
                
                photosHtml += `
                    <div class="photo-card" onclick="window.openPhoto(${safeData})">
                        <span class="timestamp-badge">${timeStr}</span>
                        <img src="${p.photoUrl}" class="photo-img" loading="lazy" style="object-position: center; object-fit: cover;">
                        <div class="photo-info border-top">
                            <div class="location-text">
                                <i data-lucide="map-pin" class="size-3 me-1"></i>${p.location || 'GPS Only'}
                            </div>
                        </div>
                    </div>
                `;
            });

            section.innerHTML = `
                <div class="staff-header bg-primary bg-opacity-10 justify-content-between">
                    <div class="d-flex align-items-center gap-3">
                        <div class="bg-primary text-white rounded p-2 shadow-sm">
                            <i data-lucide="briefcase" class="size-5"></i>
                        </div>
                        <div>
                            <h5 class="fw-bold m-0 text-primary">${caseNo}</h5>
                            <div class="text-dark small fw-bold mt-1">Client: ${caseData.clientName} <span class="text-muted fw-normal ms-2">| Handled by: ${caseData.staffName}</span></div>
                        </div>
                    </div>
                    <div class="badge bg-white text-dark border shadow-sm fs-6 px-3 py-2">
                        ${caseData.photos.length} Photos
                    </div>
                </div>
                <div class="photo-grid bg-white">
                    ${photosHtml}
                </div>
            `;
            container.appendChild(section);
        });

        lucide.createIcons();

    } catch (e) {
        console.error(e);
        container.innerHTML = `<div class="alert alert-danger mx-3 mt-3 shadow-sm border-danger"><b>Database Error:</b> ${e.message}</div>`;
    }
}

// ----------------------------------------------------
// 全局绑定事件
// ----------------------------------------------------
window.changeDate = (days) => {
    if (!dateInput) return;
    const current = new Date(dateInput.value);
    current.setDate(current.getDate() + days);
    dateInput.value = current.toISOString().split('T')[0];
    loadEvidenceImpl();
};

window.loadEvidence = loadEvidenceImpl;

// 支持输入框按回车触发搜索
window.handleEnter = (event) => {
    if (event.key === 'Enter') {
        loadEvidenceImpl();
    }
};

window.openPhoto = (data) => {
    document.getElementById('modalFullImage').src = data.photoUrl;
    document.getElementById('modalCaseNo').innerText = `Case: ${data.caseNo || 'Unknown'}`;
    document.getElementById('modalClientStaff').innerText = `Client: ${data.clientName || 'N/A'} | Staff: ${data.staffName || 'N/A'}`;
    document.getElementById('modalTime').innerText = data.localTime;
    document.getElementById('modalLocation').innerText = data.location || 'Unknown location';
    
    if (imageModal) imageModal.show();
    lucide.createIcons();
};