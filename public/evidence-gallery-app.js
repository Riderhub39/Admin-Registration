import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, orderBy, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let imageModal;
let dateInput;

export async function initEvidenceGalleryApp() {
    document.getElementById('loadingText').innerText = "Loading Gallery...";
    imageModal = new bootstrap.Modal(document.getElementById('imageModal'));
    
    dateInput = document.getElementById('dateFilter');
    dateInput.value = new Date().toLocaleDateString('en-CA'); 
    
    // 初始化加载数据
    await loadEvidenceImpl(); 
    
    document.getElementById('loadingOverlay').style.display = 'none';
    document.getElementById('mainContainer').classList.remove('d-none');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function loadEvidenceImpl() {
    const container = document.getElementById('evidenceList');
    container.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div><p class="text-muted mt-2 fw-bold">Loading logs...</p></div>';

    const dateStr = dateInput.value;
    if (!dateStr) return;

    // 获取搜索框的值并转为小写
    const searchKeyword = document.getElementById('searchFilter').value.trim().toLowerCase();

    // 构建当天的起始和结束时间
    const startDate = new Date(dateStr + "T00:00:00");
    const endDate = new Date(dateStr + "T23:59:59");

    try {
        const logsQuery = query(
            collection(db, "evidence_logs"),
            where("capturedAt", ">=", Timestamp.fromDate(startDate)),
            where("capturedAt", "<=", Timestamp.fromDate(endDate)),
            orderBy("capturedAt", "desc")
        );

        const snap = await getDocs(logsQuery);

        if (snap.empty) {
            container.innerHTML = `<div class="text-center text-muted py-5 border border-primary border-opacity-25 rounded bg-white shadow-sm">
                <i data-lucide="image-off" class="size-8 text-secondary mb-2"></i>
                <h5 class="fw-bold">No evidence uploaded on this date.</h5>
            </div>`;
            if (typeof lucide !== 'undefined') lucide.createIcons();
            return;
        }

        // 🟢 按案号 (Case No) 对照片进行分组
        const groupedCases = {};
        snap.forEach(doc => {
            const data = doc.data();
            const caseNo = data.caseNo || "Unknown Case";
            
            if (!groupedCases[caseNo]) {
                groupedCases[caseNo] = {
                    clientName: data.clientName || "",
                    photos: []
                };
            }
            groupedCases[caseNo].photos.push({ id: doc.id, ...data });
        });

        let html = '';
        let hasResults = false;

        // 渲染分组视图
        Object.entries(groupedCases).forEach(([caseNo, caseData]) => {
            const clientName = caseData.clientName;
            const photos = caseData.photos;

            // 根据搜索框过滤 (模糊匹配案号或客户名)
            if (searchKeyword) {
                const matchCase = caseNo.toLowerCase().includes(searchKeyword);
                const matchClient = clientName.toLowerCase().includes(searchKeyword);
                if (!matchCase && !matchClient) {
                    return; // 跳过不匹配的案件
                }
            }

            hasResults = true;

            // 客户名称徽章
            const clientBadge = clientName 
                ? `<span class="badge bg-warning text-dark border border-warning ms-2"><i data-lucide="briefcase" class="size-3 me-1"></i>${clientName}</span>` 
                : '';

            // 生成该案件下的所有照片卡片
            let photosHtml = photos.map(p => {
                const timeText = p.localTime ? p.localTime.split(' ')[1] : 'Unknown Time';
                
                const safeData = encodeURIComponent(JSON.stringify({
                    photoUrl: p.photoUrl,
                    caseNo: caseNo,
                    clientName: clientName,
                    staffName: p.staffName || "Unknown Staff",
                    localTime: p.localTime || "Unknown Time",
                    location: p.location || "Unknown Location"
                }));

                return `
                    <div class="evidence-card cursor-pointer" onclick="window.openPhoto('${safeData}')">
                        <div class="evidence-img-wrapper rounded shadow-sm overflow-hidden position-relative bg-dark" style="transition: 0.2s;">
                            <img src="${p.photoUrl}" loading="lazy" class="w-100 h-100 object-fit-cover" style="aspect-ratio: 1;">
                            <div class="position-absolute bottom-0 start-0 w-100 p-2 text-white bg-dark bg-opacity-75" style="font-size: 11px;">
                                <div class="fw-bold text-truncate"><i data-lucide="user" class="size-3 me-1"></i>${p.staffName || 'Staff'}</div>
                                <div><i data-lucide="clock" class="size-3 me-1"></i>${timeText}</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            // 拼装案件区块
            html += `
                <div class="bg-white p-4 rounded shadow-sm mb-4 border border-primary border-opacity-25">
                    <div class="d-flex align-items-center mb-3 pb-3 border-bottom">
                        <div class="bg-primary bg-opacity-10 text-primary rounded p-2 me-3">
                            <i data-lucide="folder-open" class="size-5"></i>
                        </div>
                        <div class="flex-grow-1">
                            <h5 class="fw-bold m-0 text-dark d-flex align-items-center">
                                ${caseNo} ${clientBadge}
                            </h5>
                            <div class="text-muted small mt-1 fw-bold"><i data-lucide="camera" class="size-3 me-1"></i>${photos.length} photos in this case</div>
                        </div>
                    </div>
                    <div class="d-grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));">
                        ${photosHtml}
                    </div>
                </div>
            `;
        });

        if (!hasResults) {
            container.innerHTML = `<div class="text-center text-muted py-5 border rounded bg-white shadow-sm">
                <h5 class="fw-bold">No cases found matching "${document.getElementById('searchFilter').value}".</h5>
            </div>`;
        } else {
            container.innerHTML = html;
        }

        if (typeof lucide !== 'undefined') lucide.createIcons();

    } catch (e) {
        console.error(e);
        container.innerHTML = `<div class="alert alert-danger mx-3 mt-3 fw-bold">Error loading evidence: ${e.message}</div>`;
    }
}

// ----------------------------------------------------
// 全局方法 (暴露给 HTML 调用)
// ----------------------------------------------------
window.changeDate = (days) => {
    if (!dateInput) return;
    const current = new Date(dateInput.value);
    current.setDate(current.getDate() + days);
    dateInput.value = current.toLocaleDateString('en-CA');
    loadEvidenceImpl();
};

window.loadEvidence = loadEvidenceImpl;

window.openPhoto = (encodedData) => {
    const data = JSON.parse(decodeURIComponent(encodedData));
    
    document.getElementById('modalFullImage').src = data.photoUrl;
    
    const clientText = data.clientName ? `<span class="text-muted fw-normal ms-2">| &nbsp;Client: ${data.clientName}</span>` : '';
    document.getElementById('modalCaseInfo').innerHTML = `${data.caseNo} ${clientText}`;
    
    document.getElementById('modalStaffName').innerHTML = `<i data-lucide="user-check" class="size-4 me-1"></i> Captured by: ${data.staffName}`;
    document.getElementById('modalTime').innerText = data.localTime;
    document.getElementById('modalLocation').innerText = data.location;

    if (typeof lucide !== 'undefined') lucide.createIcons();
    imageModal.show();
};