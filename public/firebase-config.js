// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";


// firebase-config.js

export const firebaseConfig = {
    apiKey: "AIzaSyB_NOJgB425rk89CVwVeqvqsXe9sMZymFk",
    authDomain: "fieldtrack-pro-a16b4.firebaseapp.com",
    projectId: "fieldtrack-pro-a16b4",
    // 🟢 核心修复：添加数据库地址
    // 如果你在新加坡区域，通常是这个格式：
    databaseURL: "https://fieldtrack-pro-a16b4-default-rtdb.asia-southeast1.firebasedatabase.app", 
    storageBucket: "fieldtrack-pro-a16b4.firebasestorage.app",
    messagingSenderId: "73078824026",
    appId: "1:73078824026:web:1215f9a74fc7cd4d5..." 
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Services
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// 关键步骤：必须导出这些变量，index.html 才能用
export { auth, db, storage };