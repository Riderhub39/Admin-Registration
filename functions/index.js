const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler"); // 🟢 引入定时任务
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");

admin.initializeApp();

// 🟢 强制设置云函数部署在亚洲（与你的 Firestore 数据库保持一致）
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

        const payload = {
            notification: {
                title: "📢 New Company Announcement",
                body: messageBody,
            },
            tokens: tokens
        };

        const response = await admin.messaging().sendEachForMulticast(payload);
        logger.info(`Announcement sent. Success count: ${response.successCount}`);
    } catch (error) {
        logger.error("Error sending announcement push:", error);
    }
});

// ============================================================================
// 2. 假期审批推送 (Leave Update Push)
// ============================================================================
exports.sendLeaveUpdatePush = onDocumentUpdated('leaves/{leaveId}', async (event) => {
    const change = event.data;
    if (!change) return;

    const newData = change.after.data();
    const oldData = change.before.data();

    if (oldData.status === newData.status) return;

    const authUid = newData.authUid || newData.uid;
    if (!authUid) return;

    try {
        const userQuery = await admin.firestore().collection('users').where('authUid', '==', authUid).limit(1).get();
        if (userQuery.empty) return;

        const fcmToken = userQuery.docs[0].data().fcmToken;
        if (!fcmToken) return;

        const payload = {
            notification: {
                title: "🏖️ Leave Request Update",
                body: `Your request for ${newData.type} has been ${newData.status}.`,
            },
            token: fcmToken
        };

        await admin.messaging().send(payload);
        logger.info(`Leave push sent successfully to ${authUid}`);
    } catch (error) {
        logger.error("Error sending leave push:", error);
    }
});

// ============================================================================
// 3. 薪资单发布推送 (Payslip Published Push)
// ============================================================================
exports.sendPayslipPush = onDocumentWritten('payslips/{payslipId}', async (event) => {
    const change = event.data;
    if (!change) return;

    const docData = change.after.exists ? change.after.data() : null;
    
    if (!docData) return;
    if (docData.status !== 'Published') return;

    if (change.before.exists) {
        const beforeData = change.before.data();
        if (beforeData.status === 'Published') return; 
    }

    const uid = docData.uid; 
    if (!uid) return;

    try {
        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        if (!userDoc.exists) return;

        const fcmToken = userDoc.data().fcmToken;
        if (!fcmToken) return;

        const payload = {
            notification: {
                title: "💰 Payslip Available",
                body: `Your payslip for ${docData.month} has been published and is ready to view.`,
            },
            token: fcmToken
        };

        await admin.messaging().send(payload);
        logger.info(`Payslip push sent to user ${uid}`);
    } catch (error) {
        logger.error("Error sending payslip push:", error);
    }
});

// ============================================================================
// 4. 定时任务：自动签退 (Auto Clock Out Job)
// ============================================================================
// 每天每小时的第 0 分钟运行 (例如 17:00, 18:00)，时区设为马来西亚
exports.autoClockOutJob = onSchedule({
    schedule: "0 * * * *",
    timeZone: "Asia/Kuala_Lumpur",
    retryCount: 0 // 不需要重试，下一小时会自动再扫一遍
}, async (event) => {
    logger.info("Running Auto Clock Out Job...");
    
    const db = admin.firestore();
    const now = new Date();
    // Firebase 云端默认是 UTC 时间，我们需要计算马来西亚时间 (UTC+8) 来获取正确的日期字符串
    const myTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const todayStr = myTime.toISOString().split('T')[0];
    
    try {
        // 1. 获取当天的排班
        const schedSnap = await db.collection("schedules").where("date", "==", todayStr).get();
        if (schedSnap.empty) {
            logger.info("No schedules found for today.");
            return;
        }

        const schedules = [];
        schedSnap.forEach(doc => schedules.push(doc.data()));

        // 2. 获取当天所有尚未归档的考勤记录
        const attSnap = await db.collection("attendance")
            .where("date", "==", todayStr)
            .where("verificationStatus", "in", ["Pending", "Verified", "Corrected"])
            .get();

        // 按员工分组
        const userRecords = {};
        attSnap.forEach(doc => {
            const data = doc.data();
            if (!userRecords[data.uid]) userRecords[data.uid] = [];
            userRecords[data.uid].push(data);
        });

        const batch = db.batch();
        let fixCount = 0;

        // 3. 核心判断逻辑
        for (const uid in userRecords) {
            const records = userRecords[uid];
            // 找这个人今天的排班 (兼容 userId 和 authUid)
            const mySched = schedules.find(s => s.userId === uid || s.authUid === uid);
            
            if (mySched && mySched.end) {
                // 排班结束时间
                const shiftEnd = mySched.end.toDate();
                // 宽限期：下班时间 + 1 小时
                const shiftEndPlusOneHour = new Date(shiftEnd.getTime() + (60 * 60 * 1000));

                // 如果现在的时间已经超过了宽限期
                if (now > shiftEndPlusOneHour) {
                    // 检查他是否有任何 Clock Out 的记录
                    const hasClockedOut = records.some(r => r.session === "Clock Out");

                    if (!hasClockedOut) {
                        // 发现漏打卡！帮他自动下班
                        const userObj = records[0]; 
                        
                        // 使用排班时间格式化为 HH:mm
                        // 注意：toDate() 本身会根据云端本地时区转换，但由于只取时分，建议显式调整到 UTC+8
                        const localShiftEnd = new Date(shiftEnd.getTime() + (8 * 60 * 60 * 1000));
                        const hours = localShiftEnd.getUTCHours().toString().padStart(2, '0');
                        const minutes = localShiftEnd.getUTCMinutes().toString().padStart(2, '0');
                        const autoOutTime = `${hours}:${minutes}`;

                        const newRecordRef = db.collection("attendance").doc();
                        batch.set(newRecordRef, {
                            uid: uid,
                            name: userObj.name || "Unknown",
                            email: userObj.email || "",
                            date: todayStr,
                            session: "Clock Out",
                            manualOut: autoOutTime, // 强制设定为原定的下班时间
                            verificationStatus: "Verified",
                            address: "System Auto Clock Out", 
                            timestamp: admin.firestore.Timestamp.fromDate(shiftEnd) // 强制时间戳为下班时间
                        });

                        fixCount++;
                        logger.info(`[Fixed] Auto Clock Out enforced for ${userObj.name} at ${autoOutTime}`);
                    }
                }
            }
        }

        // 4. 提交
        if (fixCount > 0) {
            await batch.commit();
            logger.info(`Successfully fixed ${fixCount} missing clock outs.`);
        } else {
            logger.info("All staff have properly clocked out. No fixes needed.");
        }

    } catch (error) {
        logger.error("Error in Auto Clock Out Job:", error);
    }
});