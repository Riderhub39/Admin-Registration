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
onAuthStateChanged(auth, async (user) => {
    if (user) {
        const loginTime = localStorage.getItem('adminLoginTime');
        const SESSION_DURATION = 8 * 60 * 60 * 1000; 

        if (!loginTime || (Date.now() - parseInt(loginTime)) > SESSION_DURATION) {
            // 如果超时或没有记录，强制登出并停留在当前登录页
            await signOut(auth);
            localStorage.removeItem('adminLoginTime');
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
                    await signOut(auth); // 普通员工角色，拒绝访问并强制登出
                    showError("Access Denied. Management privileges required.");
                }
            } else {
                await signOut(auth);
                showError("Account error: Profile not found.");
            }
        } catch (e) {
            await signOut(auth);
            showError("Error verifying permissions.");
        }
    }
});

// 登录请求处理
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMessage.classList.add('d-none');
    setLoading(true);

    const email = document.getElementById('email').value;
    const pass = document.getElementById('password').value;

    try {
       await signInWithEmailAndPassword(auth, email, pass);
   
        localStorage.setItem('adminLoginTime', Date.now().toString());
    } catch (error) {
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