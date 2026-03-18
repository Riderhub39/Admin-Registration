import { collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let db;

// 暴露初始化函数供 HTML 里的 auth-guard 回调使用
export async function initDailyTasksApp(dbInstance) {
    db = dbInstance; 

    // 在验证通过，开始拉取数据前，修改加载提示文字
    document.getElementById('loadingText').innerText = "Loading Tasks...";

    await loadTasks();

    // 渲染图标
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

async function loadTasks() {
    const tableBody = document.getElementById('daily-tasks-body');
    
    try {
        const q = query(collection(db, 'daily_tasks'), orderBy('date', 'desc'));
        const querySnapshot = await getDocs(q);

        tableBody.innerHTML = ''; 

        if (querySnapshot.empty) {
            tableBody.innerHTML = '<tr><td colspan="11" class="text-center py-4 text-muted">No daily tasks found.</td></tr>';
            return;
        }

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            
            // 格式化日期
            const dateObj = data.date ? data.date.toDate() : new Date();
            const dateStr = dateObj.toLocaleDateString('en-GB', {
                year: 'numeric', month: 'short', day: '2-digit'
            });

            // 渲染图片链接
            let imagesHtml = '';
            if (data.imageUrls && Array.isArray(data.imageUrls) && data.imageUrls.length > 0) {
                data.imageUrls.forEach(url => {
                    imagesHtml += `<a href="${url}" target="_blank" class="d-inline-block me-1 mb-1">
                        <img src="${url}" class="rounded border" style="width: 40px; height: 40px; object-fit: cover;">
                    </a>`;
                });
            } else {
                imagesHtml = '<span class="text-muted small">No images</span>';
            }

            // 是否投放 (Boosted) 的徽章样式
            const boostedBadge = data.isBoosted 
                ? `<span class="badge bg-success-subtle text-success border border-success-subtle">Yes</span>`
                : `<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">No</span>`;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="ps-4 py-3 fw-medium text-dark">${dateStr}</td>
                <td>
                    <div class="d-flex align-items-center">
                        <div class="bg-primary bg-opacity-10 text-primary rounded-circle d-flex align-items-center justify-content-center me-2" style="width: 32px; height: 32px;">
                            <i data-lucide="user" style="width: 16px; height: 16px;"></i>
                        </div>
                        <span class="fw-medium">${data.salesName || '-'}</span>
                    </div>
                </td>
                <td><span class="badge bg-light text-dark border">${data.accountType || '-'}</span></td>
                <td>${data.liveCount || 0}</td>
                <td>${data.leads || 0}</td>
                <td>${data.viewers || 0}</td>
                <td>${data.topView || 0}</td>
                <td>${data.averageView || 0}</td>
                <td>${boostedBadge}</td>
                <td style="max-width: 200px;">
                    <div class="text-truncate text-muted small" title="${data.comment || ''}">${data.comment || '-'}</div>
                </td>
                <td class="pe-4">${imagesHtml}</td>
            `;
            tableBody.appendChild(tr);
        });

    } catch (error) {
        console.error("Error fetching daily tasks:", error);
        tableBody.innerHTML = `<tr><td colspan="11" class="text-center py-4 text-danger"><i data-lucide="alert-circle" class="me-2"></i>Failed to load data: ${error.message}</td></tr>`;
    }
}