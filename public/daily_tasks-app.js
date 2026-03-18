import { collection, getDocs, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let db;
let allTasks = []; // 用于在本地保存所有拉取到的数据

// 默认的排序状态
let currentSortCol = 'date';
let currentSortDesc = true; 

export async function initDailyTasksApp(dbInstance) {
    db = dbInstance; 

    document.getElementById('loadingText').innerText = "Loading Tasks...";

    // 🟢 绑定顶部筛选输入框的事件 (当输入改变时自动触发重绘)
    document.getElementById('searchStaff').addEventListener('input', renderTable);
    document.getElementById('filterDate').addEventListener('change', renderTable);
    
    // 🟢 绑定 Reset 按钮事件
    document.getElementById('resetBtn').addEventListener('click', () => {
        document.getElementById('searchStaff').value = '';
        document.getElementById('filterDate').value = '';
        currentSortCol = 'date';
        currentSortDesc = true;
        renderTable();
    });

    // 🟢 绑定表头点击排序事件
    document.querySelectorAll('.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const clickedCol = th.getAttribute('data-sort');
            
            if (currentSortCol === clickedCol) {
                // 如果点击的是当前正在排序的列，则切换升/降序
                currentSortDesc = !currentSortDesc; 
            } else {
                // 如果点击了新列，设为新列并默认降序
                currentSortCol = clickedCol;
                currentSortDesc = true; 
            }
            renderTable();
        });
    });

    await fetchTasks();
}

// 只负责拉取一次数据并存入内存
async function fetchTasks() {
    const tableBody = document.getElementById('daily-tasks-body');
    
    try {
        const q = query(collection(db, 'daily_tasks'), orderBy('date', 'desc'));
        const querySnapshot = await getDocs(q);

        allTasks = []; // 清空数组
        querySnapshot.forEach((doc) => {
            allTasks.push({ id: doc.id, ...doc.data() });
        });

        // 拉取完毕后，触发渲染
        renderTable();

    } catch (error) {
        console.error("Error fetching daily tasks:", error);
        tableBody.innerHTML = `<tr><td colspan="11" class="text-center py-4 text-danger"><i data-lucide="alert-circle" class="me-2"></i>Failed to load data: ${error.message}</td></tr>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

// 负责过滤、排序并重绘 DOM
function renderTable() {
    const tableBody = document.getElementById('daily-tasks-body');
    
    // 1. 获取当前用户输入的筛选条件
    const searchStaff = document.getElementById('searchStaff').value.toLowerCase().trim();
    const filterDate = document.getElementById('filterDate').value; // 格式: YYYY-MM-DD

    // 2. 过滤数据
    let filteredTasks = allTasks.filter(task => {
        // 过滤员工名字 (只要包含输入字符即匹配)
        const matchName = (task.salesName || '').toLowerCase().includes(searchStaff);
        
        // 过滤日期 (精确匹配日历上选择的天)
        let matchDate = true;
        if (filterDate) {
            if (task.date) {
                const taskDateObj = task.date.toDate();
                // 补零转为 YYYY-MM-DD 格式
                const taskDateStr = `${taskDateObj.getFullYear()}-${String(taskDateObj.getMonth() + 1).padStart(2, '0')}-${String(taskDateObj.getDate()).padStart(2, '0')}`;
                matchDate = (taskDateStr === filterDate);
            } else {
                matchDate = false; // 如果任务没有日期，且选了筛选日期，则不显示
            }
        }
        
        return matchName && matchDate;
    });

    // 3. 排序数据
    filteredTasks.sort((a, b) => {
        let valA = a[currentSortCol];
        let valB = b[currentSortCol];

        // 针对日期做专门的 Timestamp 毫秒级对比
        if (currentSortCol === 'date') {
            valA = valA ? valA.toMillis() : 0;
            valB = valB ? valB.toMillis() : 0;
        } 
        // 针对字符串类型的比较（忽略大小写）
        else if (typeof valA === 'string') {
            valA = valA.toLowerCase();
            valB = (valB || '').toLowerCase();
        } 
        // 针对数字类型 (处理可能出现的 null / undefined)
        else {
            valA = valA ?? 0; 
            valB = valB ?? 0;
        }

        if (valA < valB) return currentSortDesc ? 1 : -1;
        if (valA > valB) return currentSortDesc ? -1 : 1;
        return 0;
    });

    // 4. 更新表头的排序图标 (重置所有箭头为上下，并高亮当前的排序列箭头)
    document.querySelectorAll('.sortable i').forEach(icon => {
        icon.setAttribute('data-lucide', 'arrow-up-down');
        icon.classList.replace('text-primary', 'text-muted');
    });
    const activeTh = document.querySelector(`.sortable[data-sort="${currentSortCol}"]`);
    if (activeTh) {
        const activeIcon = activeTh.querySelector('i');
        activeIcon.setAttribute('data-lucide', currentSortDesc ? 'arrow-down' : 'arrow-up');
        activeIcon.classList.replace('text-muted', 'text-primary'); // 变成蓝色高亮
    }

    // 5. 渲染表格 HTML
    tableBody.innerHTML = ''; 
    if (filteredTasks.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="11" class="text-center py-5 text-muted"><i data-lucide="inbox" class="size-6 mb-2 opacity-50 d-block mx-auto"></i>No matching tasks found.</td></tr>`;
    } else {
        filteredTasks.forEach((data) => {
            const dateObj = data.date ? data.date.toDate() : new Date();
            const dateStr = dateObj.toLocaleDateString('en-GB', {
                year: 'numeric', month: 'short', day: '2-digit'
            });

            let imagesHtml = '';
            if (data.imageUrls && Array.isArray(data.imageUrls) && data.imageUrls.length > 0) {
                data.imageUrls.forEach(url => {
                    imagesHtml += `<a href="${url}" target="_blank" class="d-inline-block me-1 mb-1">
                        <img src="${url}" class="rounded border shadow-sm" style="width: 40px; height: 40px; object-fit: cover; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'">
                    </a>`;
                });
            } else {
                imagesHtml = '<span class="text-muted small">No images</span>';
            }

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
                <td class="fw-medium">${data.liveCount || 0}</td>
                <td class="fw-medium">${data.leads || 0}</td>
                <td class="fw-medium">${data.viewers || 0}</td>
                <td class="fw-medium">${data.topView || 0}</td>
                <td class="fw-medium text-secondary">${data.averageView || 0}</td>
                <td>${boostedBadge}</td>
                <td style="max-width: 200px;">
                    <div class="text-truncate text-muted small" title="${data.comment || ''}">${data.comment || '-'}</div>
                </td>
                <td class="pe-4">${imagesHtml}</td>
            `;
            tableBody.appendChild(tr);
        });
    }

    // 重新初始化 Lucide 图标
    if (typeof window.lucide !== 'undefined') {
        window.lucide.createIcons();
    }
}