
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
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
        const SESSION_DURATION = 8 * 60 * 60 * 1000;

        if (!loginTime || (Date.now() - parseInt(loginTime)) > SESSION_DURATION) {
            alert("Your session has expired (8 hours limit). Please sign in again.");
            await signOut(auth);
            localStorage.removeItem('adminLoginTime');
            window.location.replace("index.html");
            return;
        }

        try {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            const userData = userDoc.data();

            // 🟢 定义允许进入管理后台的角色列表
            const authorizedRoles = ['admin', 'manager'];

            if (userDoc.exists() && authorizedRoles.includes(userData.role)) {
                
                // 1. 初始化顶部导航栏 (传入 userData 以便根据角色定制菜单)
                initUnifiedHeader(auth, db, userData);
                
                // 2. 执行页面的专属加载逻辑 (将 userData 传回回调，方便页面判断是 admin 还是 manager)
                if (onReadyCallback) {
                    await onReadyCallback(user, userData);
                }
                
                // 3. 隐藏加载动画，显示主界面
                if (loadingOverlay) loadingOverlay.style.display = 'none';
                if (mainContainer) mainContainer.classList.remove('d-none');

            } else {
                alert("Unauthorized Access. Management privileges required.");
                await signOut(auth);
                window.location.replace("index.html");
            }
        } catch (error) {
            console.error("Auth Guard Error:", error);
            alert("Auth Error: " + error.message);
            window.location.replace("index.html");
        }
    });
}