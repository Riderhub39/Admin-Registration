import { signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * Initializes the global header dynamically.
 */
export function initUnifiedHeader(auth, db) {
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

            highlightCurrentPage();
            attachLogoutHandler(auth);
            
            // 🔔 Start notification listeners immediately
            if (db) {
                initNotificationSystem(db);
            }
            
            // Re-render icons
            if (window.lucide) {
                window.lucide.createIcons();
            }
        })
        .catch(error => {
            console.error("Header Error:", error);
        });
}

/**
 * Logic: Manage Notification State & Render Dropdown
 */
function initNotificationSystem(db) {
    const badge = document.getElementById('notificationBadge');
    const list = document.getElementById('notificationList');
    
    // State object to hold counts
    const counts = {
        leaves: 0,
        attendance: 0,
        edits: 0
    };

    // Central function to update UI based on 'counts' object
    const updateUI = () => {
        const total = counts.leaves + counts.attendance + counts.edits;

        // 1. Toggle Red Dot
        if (total > 0) {
            badge.classList.remove('d-none');
        } else {
            badge.classList.add('d-none');
        }

        // 2. Build Dropdown List HTML
        let html = `<li><h6 class="dropdown-header fw-bold">Notifications (${total})</h6></li>`;

        if (total === 0) {
            html += `
                <li class="text-center p-4 text-muted">
                    <div class="mb-2"><i data-lucide="check-circle" class="size-6 opacity-50"></i></div>
                    <small>All caught up! No new alerts.</small>
                </li>`;
        } else {
            // Pending Leaves Item
            if (counts.leaves > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="leave_approval.html">
                            <div class="bg-warning bg-opacity-10 text-warning p-1 rounded"><i data-lucide="calendar" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small">${counts.leaves} Leave Request${counts.leaves > 1 ? 's' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Waiting for approval</div>
                            </div>
                        </a>
                    </li>`;
            }
            
            // Attendance Fixes Item
            if (counts.attendance > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="attendance.html">
                            <div class="bg-danger bg-opacity-10 text-danger p-1 rounded"><i data-lucide="clock" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small">${counts.attendance} Attendance Fix${counts.attendance > 1 ? 'es' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Requires verification</div>
                            </div>
                        </a>
                    </li>`;
            }

            // Profile Edits Item
            if (counts.edits > 0) {
                html += `
                    <li>
                        <a class="dropdown-item d-flex align-items-center gap-2 py-2" href="manage_staff.html">
                            <div class="bg-info bg-opacity-10 text-info p-1 rounded"><i data-lucide="user-pen" class="size-4"></i></div>
                            <div>
                                <div class="fw-bold small">${counts.edits} Profile Update${counts.edits > 1 ? 's' : ''}</div>
                                <div class="text-muted" style="font-size: 0.75rem;">Staff details changed</div>
                            </div>
                        </a>
                    </li>`;
            }
        }

        list.innerHTML = html;
        
        // IMPORTANT: Re-render icons inside the newly injected HTML
        if (window.lucide) window.lucide.createIcons();
    };

    // --- Listeners ---
    
    // 1. Pending Leaves
    onSnapshot(query(collection(db, "leaves"), where("status", "==", "Pending")), (snap) => {
        counts.leaves = snap.size;
        updateUI();
    });

    // 2. Pending Attendance
    onSnapshot(query(collection(db, "attendance_corrections"), where("status", "==", "Pending")), (snap) => {
        counts.attendance = snap.size;
        updateUI();
    });

    // 3. Pending Edits
    onSnapshot(query(collection(db, "edit_requests"), where("status", "==", "pending")), (snap) => {
        counts.edits = snap.size;
        updateUI();
    });
}

/**
 * Standard Header Logic
 */
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