// 文件: utils.js

// ==========================================
// 1. 数据与格式化处理
// ==========================================

/**
 * 格式化金额为马来西亚令吉格式 (RM 0.00)
 */
export function formatMoney(amount) {
    return (parseFloat(amount) || 0).toLocaleString('en-MY', { 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2 
    });
}

/**
 * 格式化时间 (支持 Firestore Timestamp, 原生 Date 对象, 以及 普通字符串)
 */
export function formatTime(val) {
    if (!val) return "--:--";
    
    // 支持原生 JavaScript Date 对象
    if (val instanceof Date) {
        return val.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    
    // 兼容 Firestore 的 Timestamp 对象
    if (val.seconds) {
        return new Date(val.seconds * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    
    // 兼容普通字符串 (如 "09:00")
    if (typeof val === 'string') return val;
    
    return "--:--";
}

/**
 * 将 Firebase Timestamp 或 Date 对象格式化为 YYYY-MM-DD
 */
export function formatDate(dateInput) {
    if (!dateInput) return '-';
    let date = dateInput.toDate ? dateInput.toDate() : new Date(dateInput);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}
export function formatDateTime(dateInput) {
    if (!dateInput) return '-';
    // 直接复用我们已经写好的 formatDate 和 formatTime
    return `${formatDate(dateInput)} ${formatTime(dateInput)}`;
}

/**
 * 将毫秒转换为 x 小时 y 分钟 (例如 1h 30m)
 */
export function msToHM(ms) {
    if (!ms || ms < 0) return "0h 0m";
    const mins = Math.floor(ms / 60000);
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * 解析法定扣款 (EPF/SOCSO/EIS) - 智能区分百分比和固定金额
 */
export function calculateStatutoryAmount(rawVal, basicAmt, defaultIsPct = false) {
    if (!rawVal) return 0;
    const str = String(rawVal).trim();
    let isPct = str.includes('%') || defaultIsPct;
    const num = parseFloat(str.replace('%', ''));
    if (isNaN(num)) return 0;
    return isPct ? (basicAmt * (num / 100)) : num;
}

/**
 * 格式化马来西亚手机号 (+60 标准)
 */
export function formatMalaysianPhone(input) {
    if (!input) return "";
    let cleaned = input.toString().replace(/\D/g, '');
    if (cleaned.startsWith('60')) return "+" + cleaned;
    else if (cleaned.startsWith('0')) return "+60" + cleaned.substring(1);
    else return "+60" + cleaned;
}

/**
 * 确保日期格式始终为 YYYY-MM-DD
 */
export function normalizeDate(dateStr) {
    if (!dateStr) return "";
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
}

// ==========================================
// 2. UI 交互控制 (Loading 与 弹窗)
// ==========================================

/**
 * 显示全局加载遮罩层 (需要 HTML 中有 <div id="loadingOverlay">)
 */
export function showLoading() {
    let overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';
}

/**
 * 隐藏全局加载遮罩层
 */
export function hideLoading() {
    let overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
}

/**
 * 显示状态提示框 (例如绿色成功框或红色报错框)
 * @param {string} elementId - 用于显示提示的 DOM 元素 ID (例如 'statusMessage')
 * @param {string} message - 提示信息
 * @param {boolean} isSuccess - true 为成功(绿色)，false 为报错(红色)
 */
export function showStatusAlert(elementId, message, isSuccess = true) {
    const el = document.getElementById(elementId);
    if (!el) return;
    
    el.style.display = 'block';
    el.style.background = isSuccess ? '#16a34a' : '#dc2626';
    el.style.color = '#fff';
    
    const icon = isSuccess ? 'check-circle' : 'alert-triangle';
    el.innerHTML = `<i data-lucide="${icon}" class="size-4 me-2 align-middle"></i> ${message}`;
    
    if (window.lucide) window.lucide.createIcons();
    
    setTimeout(() => {
        el.style.display = 'none';
    }, 4000);
}

// ==========================================
// 3. 审计日志 (Audit Trail)
// ==========================================

/**
 * 记录管理员操作审计日志 (Audit Log)
 * 用于 P1 阶段的数据安全加固与 Manager 撤销功能
 * @param {Object} db - Firestore 实例
 * @param {Object} operator - 执行操作的人 (auth.currentUser)
 * @param {String} action - 操作指令 (例如: "APPROVE_LEAVE", "MANUAL_ATTENDANCE")
 * @param {String} targetUid - 被操作的员工 ID (Employee Code 或 UID)
 * @param {Object} oldData - 修改前的原始快照 (可选，用于 Revert)
 * @param {Object} newData - 修改后的新快照 (可选)
 */
export async function logAdminAction(db, operator, action, targetUid, oldData = null, newData = null) {
    try {
        // 使用动态导入，仅在调用日志时加载 Firestore 函数
        const { addDoc, collection, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js");
        
        await addDoc(collection(db, "audit_logs"), { // 注意：你的代码里使用的是 'audit_logs'
            operatorEmail: operator.email,
            operatorUid: operator.uid,
            action: action,
            targetUid: targetUid,
            details: {
                old: oldData,
                new: newData
            },
            timestamp: serverTimestamp()
        });
        console.log(`%c[AUDIT] Action: ${action} on ${targetUid} logged.`, "color: #6366f1; font-weight: bold;");
    } catch (e) {
        console.error("Critical: Audit logging failed.", e);
    }
}