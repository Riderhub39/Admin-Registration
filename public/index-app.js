import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// 统一导入配置文件
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const loginForm = document.getElementById('loginForm');
const submitBtn = document.getElementById('submitBtn');
const btnText = document.getElementById('btnText');
const btnSpinner = document.getElementById('btnSpinner');
const errorMessage = document.getElementById('errorMessage');

/**
 * 🟢 逆向守卫：检查用户角色
 * 允许 'admin' 或 'manager' 角色进入
 */
/**
 * 🟢 逆向守卫：检查用户角色与 8 小时会话有效期
 */
onAuthStateChanged(auth, async (user) => {
    if (user) {
        const loginTime = localStorage.getItem('adminLoginTime');
        const SESSION_DURATION = 8 * 60 * 60 * 1000; 

        if (!loginTime || (Date.now() - parseInt(loginTime)) > SESSION_DURATION) {
            // 如果超时或没有记录，强制登出并停留在当前登录页
            await signOut(auth);
            localStorage.removeItem('adminLoginTime');
            setLoading(false); // 🟢 关键修复 2：阻止无限转圈
            return; 
        }

        try {
            const docSnap = await getDoc(doc(db, "users", user.uid));
            if (docSnap.exists()) {
                const userData = docSnap.data();
                // 允许 admin 和 manager 角色
                if (userData.role === 'admin' || userData.role === 'manager') {
                    window.location.replace("home.html");
                } else {
                    showError("Access Denied. Admin privileges required.");
                    await signOut(auth);
                    localStorage.removeItem('adminLoginTime'); 
                    setLoading(false);
                }
            } else {
                showError("User record not found.");
                await signOut(auth);
                localStorage.removeItem('adminLoginTime');
                setLoading(false);
            }
        } catch (e) {
            await signOut(auth);
            localStorage.removeItem('adminLoginTime');
            showError("Error verifying permissions.");
            setLoading(false); // 🟢 关键修复 3：报错时阻止无限转圈
        }
    }
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMessage.classList.add('d-none');
    setLoading(true);

    const email = document.getElementById('email').value;
    const pass = document.getElementById('password').value;

    try {
        // 🟢 关键修复 1：在触发 Firebase 登录前，先写入时间戳。
        // 这样验证成功瞬间触发 onAuthStateChanged 时，就不会读到空数据了。
        localStorage.setItem('adminLoginTime', Date.now().toString());
        
        await signInWithEmailAndPassword(auth, email, pass);
    } catch (error) {
        // 如果登录失败，把刚刚提前写入的时间戳清空
        localStorage.removeItem('adminLoginTime');
        
        let msg = "An error occurred. Please try again.";
        switch (error.code) {
            case 'auth/user-not-found':
            case 'auth/wrong-password':
            case 'auth/invalid-credential':
                msg = "Incorrect email or password.";
                break;
            case 'auth/too-many-requests':
                msg = "Too many failed attempts. Access temporarily disabled.";
                break;
        }
        showError(msg);
        setLoading(false);
    }
});

function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    if (isLoading) {
        btnText.classList.add('d-none');
        btnSpinner.classList.remove('d-none');
    } else {
        btnText.classList.remove('d-none');
        btnSpinner.classList.add('d-none');
    }
}

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.remove('d-none');
}