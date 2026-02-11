import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export async function initUnifiedHeader(auth, db) {
    const placeholder = document.getElementById('header-placeholder');
    if (!placeholder) return;

    // 1. Inject Header HTML
    placeholder.innerHTML = `
    <nav class="navbar navbar-expand-lg bg-white border-bottom sticky-top" style="z-index: 1030;">
        <div class="container-fluid px-4">
            <a class="navbar-brand d-flex align-items-center gap-2 fw-bold text-primary" href="home.html">
                <div class="bg-primary text-white rounded p-1"><i data-lucide="activity" class="size-5"></i></div>
                FieldTrack Pro
            </a>
            
            <button class="navbar-toggler border-0" type="button" data-bs-toggle="collapse" data-bs-target="#navbarContent">
                <i data-lucide="menu" class="size-6 text-muted"></i>
            </button>

            <div class="collapse navbar-collapse" id="navbarContent">
                <ul class="navbar-nav ms-auto align-items-center gap-2">
                    <li class="nav-item"><a class="nav-link" href="home.html" data-page="home">Dashboard</a></li>
                    <li class="nav-item"><a class="nav-link" href="schedule_planner.html" data-page="schedule">Schedule</a></li>
                    <li class="nav-item"><a class="nav-link" href="attendance.html" data-page="attendance">Attendance</a></li>
                    <li class="nav-item"><a class="nav-link" href="payroll.html" data-page="payroll">Payroll</a></li>
                    <li class="nav-item"><a class="nav-link" href="live_tracking.html" data-page="tracking">Live Map</a></li>
                    <li class="nav-item"><a class="nav-link" href="manage_staff.html" data-page="staff">Staff</a></li>
                    
                    <li class="nav-item dropdown ms-2">
                        <a class="nav-link position-relative text-dark" href="#" role="button" data-bs-toggle="dropdown">
                            <i data-lucide="bell" class="size-5"></i>
                            <span id="headerRedDot" class="position-absolute top-2 start-75 translate-middle p-1 bg-danger border border-light rounded-circle" style="display: none;"></span>
                        </a>
                        <ul class="dropdown-menu dropdown-menu-end shadow-sm border-0 p-2" id="notifContentPlaceholder" style="width: 280px;">
                            <li><div class="dropdown-item text-center text-muted small py-3">Loading...</div></li>
                        </ul>
                    </li>

                    <li class="nav-item ms-2 border-start ps-3">
                        <div class="d-flex align-items-center gap-2">
                            <div class="text-end d-none d-lg-block" style="line-height: 1.2;">
                                <div class="small fw-bold text-dark">Admin</div>
                                <div class="text-muted" style="font-size: 0.7rem;" id="headerUserEmail">...</div>
                            </div>
                            <button id="headerLogoutBtn" class="btn btn-sm btn-light border rounded-circle p-2 text-danger">
                                <i data-lucide="log-out" class="size-4"></i>
                            </button>
                        </div>
                    </li>
                </ul>
            </div>
        </div>
    </nav>
    `;

    // 2. Initialize Icons
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // 3. Highlight Current Page
    highlightCurrentPage();

    // 4. Auth State & Logic
    onAuthStateChanged(auth, (user) => {
        if (user) {
            // User is logged in
            const emailElem = document.getElementById('headerUserEmail');
            if(emailElem) emailElem.innerText = user.email;
            
            // Start listening for notifications
            startNotificationListener(db);
            
            // Setup Logout
            const logoutBtn = document.getElementById('headerLogoutBtn');
            if(logoutBtn) {
                logoutBtn.addEventListener('click', () => {
                    if (confirm("Logout?")) signOut(auth).then(()=> window.location.href="index.html");
                });
            }
        } else {
            // User is NOT logged in - Redirect if not on login page
            if(!window.location.pathname.includes('index.html')) {
                window.location.href = "index.html";
            }
        }
    });
}

// 🔥 Notification Logic: Listens to 3 Collections
function startNotificationListener(db) {
    let counts = {
        leave: 0,
        fix: 0,
        profile: 0
    };

    const render = () => {
        const redDot = document.getElementById('headerRedDot');
        const container = document.getElementById('notifContentPlaceholder');
        const total = counts.leave + counts.fix + counts.profile;

        // Toggle Red Dot
        if (redDot) redDot.style.display = total > 0 ? 'block' : 'none';

        // Render Dropdown Content
        if (container) {
            let html = '';
            
            if (total === 0) {
                html = `<li><div class="dropdown-item text-center py-4 text-muted small opacity-50">
                            <i data-lucide="check-circle" class="size-8 mb-2 text-success"></i><br>
                            All caught up!
                        </div></li>`;
            } else {
                html += `<li class="dropdown-header small fw-bold text-muted mb-1">PENDING APPROVALS</li>`;
                
                // A. Leave Requests
                if (counts.leave > 0) {
                    html += `
                    <li><a class="dropdown-item d-flex align-items-center gap-3 py-2" href="leave_approval.html">
                        <div class="bg-success bg-opacity-10 text-success rounded p-2"><i data-lucide="calendar-check" class="size-4"></i></div>
                        <div>
                            <div class="fw-bold text-dark" style="font-size:0.85rem;">Leave Requests</div>
                            <small class="text-danger fw-bold">${counts.leave} pending</small>
                        </div>
                    </a></li>`;
                }

                // B. Attendance Fixes
                if (counts.fix > 0) {
                    html += `
                    <li><a class="dropdown-item d-flex align-items-center gap-3 py-2" href="attendance.html">
                        <div class="bg-primary bg-opacity-10 text-primary rounded p-2"><i data-lucide="fingerprint" class="size-4"></i></div>
                        <div>
                            <div class="fw-bold text-dark" style="font-size:0.85rem;">Attendance Fixes</div>
                            <small class="text-danger fw-bold">${counts.fix} pending</small>
                        </div>
                    </a></li>`;
                }

                // C. Profile Updates
                if (counts.profile > 0) {
                    html += `
                    <li><a class="dropdown-item d-flex align-items-center gap-3 py-2" href="manage_staff.html">
                        <div class="bg-warning bg-opacity-10 text-warning rounded p-2"><i data-lucide="user-cog" class="size-4"></i></div>
                        <div>
                            <div class="fw-bold text-dark" style="font-size:0.85rem;">Profile Updates</div>
                            <small class="text-danger fw-bold">${counts.profile} requests</small>
                        </div>
                    </a></li>`;
                }
            }
            container.innerHTML = html;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }
    };

    // Listener 1: Leave Requests
    onSnapshot(query(collection(db, "leaves"), where("status", "==", "Pending")), (snap) => {
        counts.leave = snap.size;
        render();
    });

    // Listener 2: Attendance Corrections
    onSnapshot(query(collection(db, "attendance_corrections"), where("status", "==", "Pending")), (snap) => {
        counts.fix = snap.size;
        render();
    });

    // Listener 3: Profile Updates
    onSnapshot(query(collection(db, "edit_requests"), where("status", "==", "pending")), (snap) => {
        counts.profile = snap.size;
        render();
    });
}

function highlightCurrentPage() {
    const path = window.location.pathname;
    // Map URL filenames to data-page attributes
    const map = { 
        'home.html': 'home', 
        'leave_approval.html': 'home', // Leave approval falls under Dashboard
        'schedule_planner.html': 'schedule', 
        'holiday.html': 'schedule', // Holiday falls under Schedule
        'attendance.html': 'attendance', 
        'payroll.html': 'payroll', 
        'live_tracking.html': 'tracking',
        'manage_staff.html': 'staff', 
        'staff_register.html': 'staff', 
        'staff_details.html': 'staff'
    };
    
    for (const key in map) {
        if (path.includes(key)) {
            const link = document.querySelector(`.nav-link[data-page="${map[key]}"]`);
            if (link) {
                link.classList.add('active', 'text-primary', 'fw-bold');
                link.classList.remove('text-dark');
            }
        }
    }
}