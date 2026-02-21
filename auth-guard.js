// 文件: auth-guard.js
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { initUnifiedHeader } from "./header-app.js";

/**
 * 验证当前用户是否为 Admin。如果是，初始化头部并执行回调；如果不是，踢回登录页。
 * * @param {Object} app - Firebase app 实例
 * @param {Object} db - Firestore db 实例
 * @param {Function} onReadyCallback - 验证成功后要执行的业务代码
 */
export function requireAdmin(app, db, onReadyCallback) {
    const auth = getAuth(app);
    const loadingOverlay = document.getElementById('loadingOverlay');
    const mainContainer = document.getElementById('mainContainer') || document.getElementById('wrapper');

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.replace("index.html");
            return;
        }

        try {
            const adminDoc = await getDoc(doc(db, "users", user.uid));
            if (adminDoc.exists() && adminDoc.data().role === 'admin') {
                
                // 1. 初始化顶部导航栏
                initUnifiedHeader(auth, db);
                
                // 2. 执行页面的专属加载逻辑
                if (onReadyCallback) {
                    await onReadyCallback(user);
                }
                
                // 3. 隐藏加载动画，显示主界面
                if (loadingOverlay) loadingOverlay.style.display = 'none';
                if (mainContainer) mainContainer.classList.remove('d-none');

            } else {
                alert("Unauthorized Access. Admins only.");
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