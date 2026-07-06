import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const loginForm = document.getElementById('loginForm');
const submitBtn = document.getElementById('submitBtn');
const btnText = document.getElementById('btnText');
const btnSpinner = document.getElementById('btnSpinner');
const errorMessage = document.getElementById('errorMessage');

onAuthStateChanged(auth, async (user) => {
    if (user) {
        console.group("🔐 [Auth Guard Debug] Starting permission verification");
        console.log("1️⃣ [Firebase Auth] Sign-in verified for UID:", user.uid);

        const loginTime = localStorage.getItem('adminLoginTime');
        const SESSION_DURATION = 8 * 60 * 60 * 1000; 

        if (!loginTime || (Date.now() - parseInt(loginTime)) > SESSION_DURATION) {
            console.warn("🟡 [Intercepted] Session expired.");
            await signOut(auth);
            localStorage.removeItem('adminLoginTime');
            setLoading(false); 
            console.groupEnd();
            return; 
        }

        try {
            console.log("2️⃣ [Firestore] Fetching profile from 'users' collection...");
            let userData = null;

            // 🟢 Step A: 通过 authUid 获取个人资料 (Personal Info)
            const q = query(collection(db, "users"), where("authUid", "==", user.uid));
            const querySnapshot = await getDocs(q);
            
            if (!querySnapshot.empty) {
                userData = querySnapshot.docs[0].data();
                console.log("   ✅ Found profile in 'users' collection.");

                // 🟢 Step B: 关键修复！从独立集合 'user_roles' 同步权限 (Permission Sync)
                const roleDocRef = doc(db, "user_roles", user.uid);
                const roleDocSnap = await getDoc(roleDocRef);
                
                if (roleDocSnap.exists()) {
                    userData.role = roleDocSnap.data().role;
                    console.log(`   ✅ Synced role from 'user_roles': ${userData.role}`);
                } else {
                    console.error("   ❌ Permission Denied: No document in 'user_roles' for this UID.");
                }
            } else {
                console.error("   ❌ User profile not found in 'users' collection.");
            }

            if (userData && (userData.role === 'admin' || userData.role === 'manager')) {
                console.log("4️⃣ [Verdict] 🎉 Authorized! Redirecting...");
                console.groupEnd();
                window.location.replace("home.html");
            } else {
                console.error(`4️⃣ [Verdict] 🚫 Access Denied. Role: '${userData?.role || 'undefined'}'`);
                showError(`Access Denied. Admin privileges required. Role: ${userData?.role || 'None'}`);
                await signOut(auth);
                localStorage.removeItem('adminLoginTime');
                setLoading(false);
                console.groupEnd();
            }
        } catch (e) {
            console.error("🔥 [System Error] Auth Guard Exception:", e);
            showError("System error during authorization.");
            setLoading(false);
            console.groupEnd();
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
        localStorage.setItem('adminLoginTime', Date.now().toString());
        await signInWithEmailAndPassword(auth, email, pass);
    } catch (error) {
        localStorage.removeItem('adminLoginTime');
        showError("Incorrect email or password.");
        setLoading(false);
    }
});

function setLoading(isLoading) {
    if (!submitBtn) return;
    submitBtn.disabled = isLoading;
    btnText?.classList.toggle('d-none', isLoading);
    btnSpinner?.classList.toggle('d-none', !isLoading);
}

function showError(message) {
    if (!errorMessage) return;
    errorMessage.textContent = message;
    errorMessage.classList.remove('d-none');
}