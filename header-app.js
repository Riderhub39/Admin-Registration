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

            // 🟢 角色权限控制逻辑
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

/**
 * 🟢 根据用户角色调整 UI 展示
 */
function applyRolePermissions(userData) {
    if (!userData) return;

    const roleDisplay = document.getElementById('userRoleDisplay');
    const managerMenu = document.getElementById('managerOnlyMenuItem');

    // 1. 更新角色显示文字
    if (roleDisplay) {
        roleDisplay.innerText = userData.role === 'manager' ? 'Manager' : 'Admin';
    }

    // 2. 如果是 Manager，显示“管理管理员”菜单项
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
    
    const counts = {
        leaves: 0,
        attendance: 0,
        edits: 0
    };

    const updateUI = () => {
        const total = counts.leaves + counts.attendance + counts.edits;

        if (badge) {
            total > 0 ? badge.classList.remove('d-none') : badge.classList.add('d-none');
        }

        let html = `<li><h6 class="dropdown-header fw-bold">Notifications (${total})</h6></li>`;

        if (total === 0) {
            html += `
                <li class="text-center p-4 text-muted">
                    <div class="mb-2"><i data-lucide="check-circle" class="size-6 opacity-50"></i></div>
                    <small>All caught up!</small>
                </li>`;
        } else {
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
            if (counts.attendance > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="attendance.html">
                            <div class="bg-danger bg-opacity-10 text-danger p-1 rounded"><i data-lucide="clock" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small">${counts.attendance} Attendance Fix${counts.attendance > 1 ? 'es' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Verification required</div>
                            </div>
                        </a>
                    </li>`;
            }
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
        }

        if (list) list.innerHTML = html;
        if (window.lucide) window.lucide.createIcons();
    };

    onSnapshot(query(collection(db, "leaves"), where("status", "==", "Pending")), (snap) => {
        counts.leaves = snap.size;
        updateUI();
    });

    onSnapshot(query(collection(db, "attendance_corrections"), where("status", "==", "Pending")), (snap) => {
        counts.attendance = snap.size;
        updateUI();
    });

    onSnapshot(query(collection(db, "edit_requests"), where("status", "==", "pending")), (snap) => {
        counts.edits = snap.size;
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