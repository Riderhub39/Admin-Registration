const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2"); // 🟢 引入全局设置
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