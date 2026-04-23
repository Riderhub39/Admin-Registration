import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
// 🟢 补全 Firestore 查询所需的 import
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
            alert("Your session has expired (12 hours limit). Please sign in again.");
            await signOut(auth);
            localStorage.removeItem('adminLoginTime');
            window.location.replace("index.html");
            return;
        }

        try {
            let userData = null;
            let userDocExists = false;

            // 🟢 尝试 1：假设 Document ID 就是 Firebase Auth UID (适用于原始的 Manager/Admin)
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (userDoc.exists()) {
                userData = userDoc.data();
                userDocExists = true;
            } else {
                // 🟢 尝试 2：如果直接找 ID 找不到 (针对从 Staff 提升上来的新 Admin)
                // 查找 users 集合中 authUid 字段等于当前登录 UID 的文档
                const q = query(collection(db, "users"), where("authUid", "==", user.uid));
                const querySnapshot = await getDocs(q);
                if (!querySnapshot.empty) {
                    userData = querySnapshot.docs[0].data();
                    userDocExists = true;
                }
            }

            // 🟢 定义允许进入管理后台的角色列表
            const authorizedRoles = ['admin', 'manager'];

            // 🟢 使用新获取的 userData 来验证权限
            if (userDocExists && userData && authorizedRoles.includes(userData.role)) {
                
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