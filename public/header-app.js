import { signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * Initializes the global header dynamically.
 * @param {Object} auth - Firebase Auth instance
 * @param {Object} db - Firestore instance
 * @param {Object} userData - Current user's document data (contains role)
 */
export function initUnifiedHeader(auth, db, userData = null) {
    const placeholder = document.getElementById('header-placeholder');
    if (!placeholder) {
        console.warn("Header placeholder not found.");
        return; 
    }

    fetch('header.html')
        .then(response => {
            if (!response.ok) throw new Error("Failed to load header");
            return response.text();
        })
        .then(html => {
            placeholder.innerHTML = html;

            applyRolePermissions(userData);
            highlightCurrentPage();
            attachLogoutHandler(auth);
            
            if (db) {
                initNotificationSystem(db);
            }
            
            if (window.lucide) {
                window.lucide.createIcons();
            }
        })
        .catch(error => {
            console.error("Header Error:", error);
        });
}

function applyRolePermissions(userData) {
    if (!userData) return;

    const roleDisplay = document.getElementById('userRoleDisplay');
    const managerMenu = document.getElementById('managerOnlyMenuItem');

    if (roleDisplay) {
        roleDisplay.innerText = userData.role === 'manager' ? 'Manager' : 'Admin';
    }

    if (userData.role === 'manager' && managerMenu) {
        managerMenu.classList.remove('d-none');
    }
}

/**
 * Logic: Manage Notification State & Render Dropdown
 */
function initNotificationSystem(db) {
    const badge = document.getElementById('notificationBadge');
    const list = document.getElementById('notificationList');
    
    // 🟢 添加了 dailyTasks 计数
    const counts = {
        leaves: 0,
        attendanceCorrections: 0,
        attendancePending: 0,
        edits: 0,
        missingClockOuts: 0,
        dailyTasks: 0 // 新增：今日日常任务数
    };

    // 🟢 提前定义昨天的日期，以便在 updateUI 中拼接到 URL 中
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const updateUI = () => {
        // 🟢 将 dailyTasks 加入总数计算
        const total = counts.leaves + counts.attendanceCorrections + counts.attendancePending + counts.edits + counts.missingClockOuts + counts.dailyTasks;

        if (badge) {
            total > 0 ? badge.classList.remove('d-none') : badge.classList.add('d-none');
            badge.innerText = total > 9 ? '9+' : total; 
        }

        let html = `<li><h6 class="dropdown-header fw-bold">Notifications (${total})</h6></li>`;

        if (total === 0) {
            html += `
                <li class="text-center p-4 text-muted">
                    <div class="mb-2"><i data-lucide="check-circle" class="size-6 opacity-50"></i></div>
                    <small>All caught up!</small>
                </li>`;
        } else {
            // 1. Missing Clock Outs (Yesterday)
            if (counts.missingClockOuts > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="attendance.html?date=${yStr}&filter=missingOut">
                            <div class="bg-dark bg-opacity-10 text-dark p-1 rounded"><i data-lucide="user-minus" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small text-warning">${counts.missingClockOuts} Missing Clock Out${counts.missingClockOuts > 1 ? 's' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">From ${yStr}</div>
                            </div>
                        </a>
                    </li>`;
            }

            // 2. 请假申请
            if (counts.leaves > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="leave_approval.html">
                            <div class="bg-warning bg-opacity-10 text-warning p-1 rounded"><i data-lucide="calendar" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small">${counts.leaves} Leave Request${counts.leaves > 1 ? 's' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Awaiting approval</div>
                            </div>
                        </a>
                    </li>`;
            }

            // 3. 考勤修正申请
            if (counts.attendanceCorrections > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="attendance.html?tab=corrections">
                            <div class="bg-danger bg-opacity-10 text-danger p-1 rounded"><i data-lucide="alert-circle" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small">${counts.attendanceCorrections} Correction Request${counts.attendanceCorrections > 1 ? 's' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Staff requested fixes</div>
                            </div>
                        </a>
                    </li>`;
            }

            // 4. 待验证日常打卡
            if (counts.attendancePending > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="attendance.html?filter=unverified">
                            <div class="bg-primary bg-opacity-10 text-primary p-1 rounded"><i data-lucide="clock" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small">${counts.attendancePending} Unverified Log${counts.attendancePending > 1 ? 's' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Daily logs to verify</div>
                            </div>
                        </a>
                    </li>`;
            }

            // 5. 资料修改申请
            if (counts.edits > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="manage_staff.html">
                            <div class="bg-info bg-opacity-10 text-info p-1 rounded"><i data-lucide="user-pen" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small">${counts.edits} Profile Update${counts.edits > 1 ? 's' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Staff modifications</div>
                            </div>
                        </a>
                    </li>`;
            }

            // 🟢 6. 今日日常任务 (Daily Tasks)
            if (counts.dailyTasks > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="daily_tasks.html">
                            <div class="bg-success bg-opacity-10 text-success p-1 rounded"><i data-lucide="clipboard-check" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small text-success">${counts.dailyTasks} Daily Task${counts.dailyTasks > 1 ? 's' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Submitted today</div>
                            </div>
                        </a>
                    </li>`;
            }
        }

        if (list) list.innerHTML = html;
        if (window.lucide) window.lucide.createIcons();
    };

    // --- Listeners ---
    
    // 监听昨天的异常打卡
    onSnapshot(query(collection(db, "attendance"), where("date", "==", yStr)), (snap) => {
        const userRecords = {};
        snap.forEach(doc => {
            const data = doc.data();
            if (!userRecords[data.uid]) userRecords[data.uid] = { hasIn: false, hasOut: false };
            if (data.session === 'Clock In') userRecords[data.uid].hasIn = true;
            if (data.session === 'Clock Out') userRecords[data.uid].hasOut = true;
        });

        let missingCount = 0;
        for (const uid in userRecords) {
            if (userRecords[uid].hasIn && !userRecords[uid].hasOut) {
                missingCount++;
            }
        }
        counts.missingClockOuts = missingCount;
        updateUI();
    });

    onSnapshot(query(collection(db, "leaves"), where("status", "==", "Pending")), (snap) => {
        counts.leaves = snap.size;
        updateUI();
    });

    onSnapshot(query(collection(db, "attendance_corrections"), where("status", "==", "Pending")), (snap) => {
        counts.attendanceCorrections = snap.size;
        updateUI();
    });

    onSnapshot(query(collection(db, "attendance"), where("verificationStatus", "==", "Pending")), (snap) => {
        counts.attendancePending = snap.size;
        updateUI();
    });

    onSnapshot(query(collection(db, "edit_requests"), where("status", "==", "pending")), (snap) => {
        counts.edits = snap.size;
        updateUI();
    });

    // 🟢 监听今日提交的 Daily Tasks
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0); // 今天的 00:00:00
    
    onSnapshot(query(collection(db, "daily_tasks"), where("date", ">=", todayStart)), (snap) => {
        counts.dailyTasks = snap.size;
        updateUI();
    });
}

function highlightCurrentPage() {
    const currentPath = window.location.pathname.split("/").pop().split("?")[0] || 'index.html';
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        if (link.getAttribute('href') === currentPath) {
            link.classList.add('active', 'fw-bold', 'text-primary');
        } else {
            link.classList.remove('active', 'fw-bold', 'text-primary');
        }
    });
}

function attachLogoutHandler(auth) {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            if (confirm("Are you sure you want to sign out?")) {
                try {
                    await signOut(auth);
                    window.location.href = 'index.html';
                } catch (error) {
                    alert("Logout failed.");
                }
            }
        });
    }
}