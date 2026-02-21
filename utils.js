// 文件: utils.js

/**
 * 格式化金额为马来西亚令吉格式 (RM 0.00)
 */
export function formatMoney(amount) {
    return (parseFloat(amount) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 格式化时间 (处理 Firestore Timestamp 或 普通字符串)
 */
export function formatTime(val) {
    if (!val) return "--:--";
    
    // 🟢 修复：新增对原生 JavaScript Date 对象的支持
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