const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler"); // 引入定时任务
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");

// 初始化 Admin SDK (增加防重复初始化判定)
if (!admin.apps.length) {
    admin.initializeApp();
}

// 强制设置云函数部署在亚洲（与您的 Firestore 数据库区域保持一致）
setGlobalOptions({ region: 'asia-southeast1' });

// ============================================================================
// 1. 公告推送 (Announcement Push) - 保留您的原有逻辑
// ============================================================================
exports.sendAnnouncementPush = onDocumentCreated('announcements/{docId}', async (event) => {
    const snap = event.data;
    if (!snap) return;

    const data = snap.data();
    const messageBody = data.message || "A new announcement has been posted.";

    try {
        const usersSnap = await admin.firestore().collection('users')
            .where('status', 'in', ['active', 'locked']) 
            .get();

        const tokens = [];
        usersSnap.forEach(doc => {
            const u = doc.data();
            if (u.fcmToken) {
                tokens.push(u.fcmToken);
            }
        });

        if (tokens.length === 0) {
            logger.info("No users have FCM tokens. Skipping announcement push.");
            return;
        }

        const payload = {
            notification: {
                title: "📢 New Company Announcement",
                body: messageBody
            }
        };

        // 注意：sendToDevice 在新版 SDK 中已被标记弃用，但为了兼容您的旧代码仍保留。
        // 未来建议升级为 admin.messaging().sendEachForMulticast()
        await admin.messaging().sendToDevice(tokens, payload);
        logger.info(`Successfully sent announcement push to ${tokens.length} devices.`);
    } catch (error) {
        logger.error("Error sending announcement push:", error);
    }
});


// ... (如果您还有其他的云函数，例如请假通知等，请保留粘贴在这里) ...


// ============================================================================
// 2. 自动签退补齐 (Auto Clock Out Job) - 🚀 已彻底修复终极版
// ============================================================================
exports.autoClockOutJob = onSchedule({
    schedule: "59 23 * * *", // 每天晚上 23:59 触发
    timeZone: "Asia/Kuala_Lumpur", // 🟢 修复 1：强制指定马来西亚时区，避免 UTC 导致抓错日期
    retryCount: 3 // 如果因网络波动失败，允许最多重试 3 次
}, async (event) => {
    const db = admin.firestore();
    
    // 1. 获取准确的马来西亚时间当天日期字符串 (格式: YYYY-MM-DD)
    const now = new Date();
    const mytTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    const todayStr = mytTime.getFullYear() + "-" + 
                     String(mytTime.getMonth() + 1).padStart(2, '0') + "-" + 
                     String(mytTime.getDate()).padStart(2, '0');

    try {
        // 2. 直接查询考勤表，获取今天【所有】的打卡记录
        const attendanceRef = db.collection("attendance").where("date", "==", todayStr);
        const snapshot = await attendanceRef.get();

        const clockIns = {};
        const clockOuts = {};

        // 3. 将今天的考勤记录按人头分类
        // 🟢 修复 2：使用 identifier 完美兼容 data.uid 和 data.userId，彻底解决 ID 错乱导致的漏人问题
        snapshot.forEach(doc => {
            const data = doc.data();
            const identifier = data.uid || data.userId; 
            
            if (!identifier) return; // 跳过脏数据

            if (data.session === "Clock In") {
                clockIns[identifier] = data;
            } else if (data.session === "Clock Out") {
                clockOuts[identifier] = data;
            }
        });

        const batch = db.batch();
        let fixCount = 0;

        // 4. 遍历所有今天有签到 (Clock In) 记录的员工
        // 🟢 修复 3：不再依赖排班表匹配！只要签到了且没签退，无论是正常班还是临时加班，统统自动补齐
        for (const [identifier, inData] of Object.entries(clockIns)) {
            // 如果此人只有 Clock In，但在 clockOuts 字典里找不到他
            if (!clockOuts[identifier]) {
                
                const autoOutTime = "23:59";
                
                // 构建带有正确时区的强制签退时间戳 (+08:00 马来西亚时间)
                const forceTimestamp = new Date(`${todayStr}T23:59:00+08:00`);

                const newRecordRef = db.collection("attendance").doc();
                batch.set(newRecordRef, {
                    uid: identifier,
                    name: inData.name || "Unknown Staff",
                    email: inData.email || "",
                    date: todayStr,
                    session: "Clock Out",
                    manualOut: autoOutTime,
                    verificationStatus: "Verified",
                    address: "System Auto Clock Out", 
                    remarks: "Forced by system due to missing clock out",
                    timestamp: admin.firestore.Timestamp.fromDate(forceTimestamp)
                });

                fixCount++;
                logger.info(`[Fixed] Auto Clock Out enforced for ${inData.name || identifier} at ${autoOutTime}`);
            }
        }

        // 5. 批量提交修改到数据库
        if (fixCount > 0) {
            await batch.commit();
            logger.info(`✅ Successfully fixed ${fixCount} missing clock outs for ${todayStr}.`);
        } else {
            logger.info(`👍 All active staff properly clocked out today (${todayStr}). No fixes needed.`);
        }

    } catch (error) {
        logger.error("❌ Error in Auto Clock Out Job:", error);
    }
});