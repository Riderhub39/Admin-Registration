const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
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
// 1. 公告推送 (Announcement Push)
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

        // 🟢 升级：使用新版 SDK 推荐的 sendEachForMulticast
        const payload = {
            notification: {
                title: "📢 New Company Announcement",
                body: messageBody
            },
            tokens: tokens // 传入 Token 数组
        };

        const response = await admin.messaging().sendEachForMulticast(payload);
        logger.info(`Successfully sent announcement push. Success: ${response.successCount}, Failed: ${response.failureCount}`);
        
    } catch (error) {
        logger.error("Error sending announcement push:", error);
    }
});


// ============================================================================
// 2. 自动签退补齐 (Auto Clock Out Job)
// ============================================================================
exports.autoClockOutJob = onSchedule({
    schedule: "59 23 * * *",       // 每天晚上 23:59 触发
    timeZone: "Asia/Kuala_Lumpur", // 强制指定马来西亚时区
    retryCount: 3                  // 网络波动失败，允许最多重试 3 次
}, async (event) => {
    const db = admin.firestore();
    
    // 1. 获取准确的马来西亚时间当天日期字符串 (格式: YYYY-MM-DD)
    const now = new Date();
    const mytTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    const todayStr = mytTime.getFullYear() + "-" + 
                     String(mytTime.getMonth() + 1).padStart(2, '0') + "-" + 
                     String(mytTime.getDate()).padStart(2, '0');

    try {
        // 2. 查询考勤表，获取今天【所有】的打卡记录
        const attendanceRef = db.collection("attendance").where("date", "==", todayStr);
        const snapshot = await attendanceRef.get();

        // 用于将当天的考勤记录按用户归类
        const userRecords = {};

        snapshot.forEach(doc => {
            const data = doc.data();
            const identifier = data.uid || data.userId; 
            
            if (!identifier || !data.timestamp) return; // 跳过脏数据

            if (!userRecords[identifier]) {
                userRecords[identifier] = [];
            }
            userRecords[identifier].push(data);
        });

        let batch = db.batch();
        let fixCount = 0;
        let batchOperationCount = 0; // 追踪 Batch 操作数量

        const forceTimestamp = new Date(`${todayStr}T23:59:00+08:00`);

        // 3. 遍历所有今天有打卡记录的员工
        for (const [identifier, records] of Object.entries(userRecords)) {
            
            // 🟢 修复：按时间戳降序排列，只看该员工今天最后一次的打卡状态
            records.sort((a, b) => {
                const timeA = a.timestamp.toMillis ? a.timestamp.toMillis() : a.timestamp;
                const timeB = b.timestamp.toMillis ? b.timestamp.toMillis() : b.timestamp;
                return timeB - timeA; 
            });

            const latestRecord = records[0];

            // 4. 如果最后一条记录是 "Clock In"，代表下班忘记打卡（包括加了临时班没退卡的情况）
            if (latestRecord.session === "Clock In") {
                
                const newRecordRef = db.collection("attendance").doc();
                batch.set(newRecordRef, {
                    uid: identifier,
                    name: latestRecord.name || "Unknown Staff",
                    email: latestRecord.email || "",
                    date: todayStr,
                    session: "Clock Out",
                    manualOut: "23:59",
                    verificationStatus: "Verified",
                    address: "System Auto Clock Out", 
                    remarks: "Forced by system due to missing clock out",
                    timestamp: admin.firestore.Timestamp.fromDate(forceTimestamp)
                });

                fixCount++;
                batchOperationCount++;
                logger.info(`[Fixed] Auto Clock Out enforced for ${latestRecord.name || identifier}`);

                // 🟢 保护机制：Firestore 的 batch 一次最多提交 500 个操作
                if (batchOperationCount === 450) {
                    await batch.commit();
                    batch = db.batch(); // 重新实例化新的 batch
                    batchOperationCount = 0;
                }
            }
        }

        // 5. 提交剩余的 batch
        if (batchOperationCount > 0) {
            await batch.commit();
        }

        if (fixCount > 0) {
            logger.info(`✅ Successfully fixed ${fixCount} missing clock outs for ${todayStr}.`);
        } else {
            logger.info(`👍 All active staff properly clocked out today (${todayStr}). No fixes needed.`);
        }

    } catch (error) {
        logger.error("❌ Error in Auto Clock Out Job:", error);
    }
});