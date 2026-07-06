import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { initUnifiedHeader } from "./header-app.js";

export function requireAdmin(app, db, onReadyCallback) {
    const auth = getAuth(app);
    const loadingOverlay = document.getElementById('loadingOverlay');
    const mainContainer = document.getElementById('mainContainer') || document.getElementById('wrapper');

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.replace("index.html");
            return;
        }

        const loginTime = localStorage.getItem('adminLoginTime');
        const SESSION_DURATION = 12 * 60 * 60 * 1000;

        if (!loginTime || (Date.now() - parseInt(loginTime)) > SESSION_DURATION) {
            alert("Your session has expired. Please sign in again.");
            await signOut(auth);
            localStorage.removeItem('adminLoginTime');
            window.location.replace("index.html");
            return;
        }

        try {
            let userData = null;
            let userDocExists = false;

            // 1. 获取个人资料 (从 users 集合)
            const q = query(collection(db, "users"), where("authUid", "==", user.uid));
            const querySnapshot = await getDocs(q);
            
            if (!querySnapshot.empty) {
                userData = querySnapshot.docs[0].data();
                userDocExists = true;
                
                // 🟢 关键修复：从独立的 user_roles 集合同步最新权限角色
                const roleDocRef = doc(db, "user_roles", user.uid);
                const roleDocSnap = await getDoc(roleDocRef);
                
                if (roleDocSnap.exists()) {
                    userData.role = roleDocSnap.data().role;
                    console.log(`[Auth Guard] Role synced from user_roles: ${userData.role}`);
                } else {
                    console.warn("[Auth Guard] No role document found in user_roles.");
                }
            }

            // 2. 权限校验
            const authorizedRoles = ['admin', 'manager'];
            if (userDocExists && userData && authorizedRoles.includes(userData.role)) {
                
                // 3. 初始化导航栏
                initUnifiedHeader(auth, db, userData);
                
                // 4. 执行回调
                if (onReadyCallback) {
                    await onReadyCallback(user, userData);
                }
                
                if (loadingOverlay) loadingOverlay.style.display = 'none';
                if (mainContainer) mainContainer.classList.remove('d-none');

            } else {
                console.error(`[Auth Guard] Unauthorized: User '${user.email}' has role '${userData?.role}'`);
                alert("Unauthorized Access. Management privileges required.");
                await signOut(auth);
                window.location.replace("index.html");
            }
        } catch (error) {
            console.error("[Auth Guard] Error:", error);
            alert("Auth Error: " + error.message);
            window.location.replace("index.html");
        }
    });
}