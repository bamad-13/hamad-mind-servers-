// ============================================================
// Hamad Mind Server v5.0.0
// Chat + TTS + Update + Admin + MongoDB + نظام الحظر
// ============================================================

const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// ============================================================
// 1. الإعدادات
// ============================================================
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'hamad_admin_2026';
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'hamadmind';

// حد الرسائل لكل مستخدم (عدّله كما تريد)
const MAX_MESSAGES_PER_USER = 100;

// نافذة الوقت للحد (24 ساعة)
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------- المفاتيح ----------
const RAW_KEYS = process.env.GEMINI_API_KEYS || '';
const GEMINI_API_KEYS = RAW_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0);

if (GEMINI_API_KEYS.length === 0) {
    console.error('❌ GEMINI_API_KEYS غير موجود في متغيرات البيئة');
    process.exit(1);
}
console.log(`✅ تم تحميل ${GEMINI_API_KEYS.length} مفتاح`);

if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI غير موجود في متغيرات البيئة');
    process.exit(1);
}
console.log(`✅ MONGODB_URI مُهيأ`);

let currentKeyIndex = 0;
function getCurrentKey() { return GEMINI_API_KEYS[currentKeyIndex]; }
function switchToNextKey() {
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
    console.log(`🔄 التبديل إلى المفتاح رقم ${currentKeyIndex + 1}`);
}
function createClient() { return new GoogleGenAI({ apiKey: getCurrentKey() }); }

// ---------- النماذج ----------
const AVAILABLE_MODELS = {
    'flash':        'gemini-2.5-flash',
    'flash-lite':   'gemini-2.5-flash-lite',
    'flash-2.0':    'gemini-2.0-flash',
    'flash-1.5':    'gemini-1.5-flash'
};
function resolveModel(key) { return AVAILABLE_MODELS[key] || 'gemini-2.5-flash'; }

// ============================================================
// 2. الاتصال بـ MongoDB
// ============================================================
let db = null;
const mongoClient = new MongoClient(MONGODB_URI);

async function connectDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        console.log('✅ تم الاتصال بـ MongoDB');

        // إنشاء الفهارس (indices) للأداء
        await db.collection('users').createIndex({ userId: 1 }, { unique: true });
        await db.collection('messages').createIndex({ userId: 1, time: -1 });
        await db.collection('config').createIndex({ key: 1 }, { unique: true });

        console.log('✅ تم إنشاء الفهارس');
    } catch (error) {
        console.error('❌ فشل الاتصال بـ MongoDB:', error.message);
    }
}
connectDB();

// ============================================================
// 3. دوال مساعدة لقاعدة البيانات
// ============================================================

// الحصول على مستخدم أو إنشاؤه
async function getOrCreateUser(userId) {
    if (!db) return null;
    const users = db.collection('users');
    let user = await users.findOne({ userId });
    if (!user) {
        user = {
            userId,
            messageCount: 0,
            totalMessages: 0,
            isBlocked: false,
            firstSeen: new Date(),
            lastSeen: new Date(),
            messageCountWindow: 0,
            windowStart: new Date()
        };
        await users.insertOne(user);
    }
    return user;
}

// التحقق من الحظر والحد اليومي
async function checkUserQuota(userId) {
    if (!db) return { allowed: true };

    const user = await getOrCreateUser(userId);
    if (!user) return { allowed: true };

    // 1. هل هو محظور؟
    if (user.isBlocked) {
        return {
            allowed: false,
            reason: '🚫 أنت محظور من استخدام Hamad Mind. تواصل مع المطور.'
        };
    }

    // 2. فحص النافذة الزمنية (24 ساعة)
    const now = new Date();
    const windowStart = new Date(user.windowStart || now);
    const elapsed = now - windowStart;

    // إذا مرت أكثر من 24 ساعة، أعد تصفير العداد
    if (elapsed > QUOTA_WINDOW_MS) {
        await db.collection('users').updateOne(
            { userId },
            { $set: { messageCountWindow: 0, windowStart: now } }
        );
        return { allowed: true, count: 0, max: MAX_MESSAGES_PER_USER };
    }

    // 3. هل تجاوز الحد؟
    const count = user.messageCountWindow || 0;
    if (count >= MAX_MESSAGES_PER_USER) {
        return {
            allowed: false,
            reason: `🚫 تجاوزت الحد المسموح (${MAX_MESSAGES_PER_USER} رسالة في 24 ساعة). حاول غدًا.`,
            count, max: MAX_MESSAGES_PER_USER
        };
    }

    return { allowed: true, count, max: MAX_MESSAGES_PER_USER };
}

// تسجيل رسالة جديدة
async function recordMessage(userId, userMessage, aiReply, model) {
    if (!db) return;

    const now = new Date();

    // 1. تحديث المستخدم
    await db.collection('users').updateOne(
        { userId },
        {
            $inc: { messageCount: 1, totalMessages: 1, messageCountWindow: 1 },
            $set: { lastSeen: now, lastMessage: userMessage }
        }
    );

    // 2. حفظ الرسالة
    await db.collection('messages').insertOne({
        userId,
        user: userMessage,
        ai: aiReply,
        model,
        time: now
    });
}

// ============================================================
// 4. Middleware للتحقق من Admin
// ============================================================
function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.body.adminToken || req.query.token;
    if (!token || token !== ADMIN_TOKEN) {
        return res.status(401).json({ error: 'غير مصرح — توكن Admin غير صحيح' });
    }
    next();
}

// ============================================================
// 5. استدعاء Gemini مع تبديل المفاتيح
// ============================================================
async function callGeminiWithRetry(modelKey, contents, systemPrompt) {
    const attempts = GEMINI_API_KEYS.length;
    let lastError = null;

    for (let i = 0; i < attempts; i++) {
        try {
            const ai = createClient();
            const config = {};
            if (systemPrompt) config.systemInstruction = systemPrompt;

            const response = await ai.models.generateContent({
                model: resolveModel(modelKey),
                contents: contents,
                config: config
            });
            return response.text || '(لا يوجد رد)';
        } catch (error) {
            lastError = error;
            console.warn(`⚠️ فشل المفتاح ${currentKeyIndex + 1}: ${error.message}`);
            switchToNextKey();
        }
    }
    throw new Error('فشلت جميع المفاتيح: ' + (lastError ? lastError.message : 'خطأ'));
}

// ============================================================
// 6. مسار المحادثة
// ============================================================
app.post('/v1/chat', async (req, res) => {
    try {
        const { message, history, model, userId, systemPrompt } = req.body;
        if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });

        const uid = userId || 'anonymous';

        // 1. فحص الحظر والحد
        const quota = await checkUserQuota(uid);
        if (!quota.allowed) {
            return res.status(403).json({
                error: quota.reason,
                blocked: true,
                count: quota.count,
                max: quota.max
            });
        }

        // 2. بناء contents
        const contents = [];
        if (Array.isArray(history)) {
            history.forEach(item => {
                if ((item.role === 'user' || item.role === 'assistant') && item.text) {
                    contents.push({
                        role: item.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: item.text }]
                    });
                }
            });
        }
        contents.push({ role: 'user', parts: [{ text: message }] });

        // 3. استدعاء Gemini
        const usedModel = resolveModel(model || 'flash');
        const reply = await callGeminiWithRetry(model || 'flash', contents, systemPrompt || null);

        // 4. تسجيل الرسالة
        await recordMessage(uid, message, reply, usedModel);

        // 5. إرجاع الرد
        res.json({
            reply: reply,
            usedModel: usedModel,
            quota: {
                used: (quota.count || 0) + 1,
                max: MAX_MESSAGES_PER_USER,
                remaining: MAX_MESSAGES_PER_USER - ((quota.count || 0) + 1)
            }
        });

    } catch (error) {
        console.error('❌ /v1/chat:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 7. مسار TTS
// ============================================================
app.post('/v1/tts', async (req, res) => {
    try {
        const { text, voice } = req.body;
        if (!text) return res.status(400).json({ error: 'النص مطلوب' });

        const attempts = GEMINI_API_KEYS.length;
        let lastError = null;

        for (let i = 0; i < attempts; i++) {
            try {
                const ai = createClient();
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash-preview-tts',
                    contents: [{ role: 'user', parts: [{ text: text }] }],
                    config: {
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: { voiceName: voice || 'Kore' }
                            }
                        }
                    }
                });

                const candidate = response.candidates && response.candidates[0];
                if (!candidate || !candidate.content || !candidate.content.parts)
                    throw new Error('لم يصل صوت من Gemini');

                let audioBase64 = null;
                for (const part of candidate.content.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        audioBase64 = part.inlineData.data;
                        break;
                    }
                }
                if (!audioBase64) throw new Error('لا توجد بيانات صوتية');

                return res.json({ data: audioBase64, mimeType: 'audio/wav', voice: voice || 'Kore' });
            } catch (error) {
                lastError = error;
                switchToNextKey();
            }
        }
        throw new Error('فشل TTS: ' + (lastError ? lastError.message : 'خطأ'));
    } catch (error) {
        console.error('❌ /v1/tts:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 8. مسار التحديث (عام)
// ============================================================
app.get('/v1/update', async (req, res) => {
    try {
        if (!db) return res.json({ version_code: 201, version_name: '2.0.1', apk_url: '', notes: '' });
        const config = await db.collection('config').findOne({ key: 'update' });
        if (!config) {
            return res.json({
                version_code: 201,
                version_name: '2.0.1',
                apk_url: '',
                notes: 'لا يوجد تحديث حالي'
            });
        }
        res.json({
            version_code: config.version_code || 201,
            version_name: config.version_name || '2.0.1',
            apk_url: config.apk_url || '',
            notes: config.notes || ''
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 9. مسار الصور (قيد التطوير)
// ============================================================
app.post('/v1/image', (req, res) => {
    res.status(501).json({ error: 'توليد الصور غير مهيأ بعد' });
});

// ============================================================
// 10. ADMIN APIs
// ============================================================

// 📊 الإحصائيات
app.get('/v1/admin/stats', requireAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متصلة' });

        const totalUsers = await db.collection('users').countDocuments();
        const blockedUsers = await db.collection('users').countDocuments({ isBlocked: true });
        const totalMessages = await db.collection('messages').countDocuments();

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const messagesLast24h = await db.collection('messages').countDocuments({
            time: { $gte: oneDayAgo }
        });

        // مجموع رسائل جميع المستخدمين
        const pipeline = [
            { $group: { _id: null, total: { $sum: '$totalMessages' } } }
        ];
        const agg = await db.collection('users').aggregate(pipeline).toArray();
        const totalFromUsers = agg.length > 0 ? agg[0].total : 0;

        res.json({
            totalUsers,
            blockedUsers,
            totalMessages,
            totalMessagesFromUsers: totalFromUsers,
            messagesLast24h,
            maxPerUser: MAX_MESSAGES_PER_USER,
            keysLoaded: GEMINI_API_KEYS.length,
            currentKeyIndex: currentKeyIndex + 1,
            serverVersion: '5.0.0',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 👥 المستخدمون
app.get('/v1/admin/users', requireAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متصلة' });

        const limit = parseInt(req.query.limit) || 50;
        const users = await db.collection('users')
            .find({})
            .sort({ lastSeen: -1 })
            .limit(limit)
            .toArray();

        const total = await db.collection('users').countDocuments();

        res.json({
            users: users.map(u => ({
                userId: u.userId,
                messageCount: u.messageCount || 0,
                totalMessages: u.totalMessages || 0,
                messageCountWindow: u.messageCountWindow || 0,
                isBlocked: u.isBlocked || false,
                firstSeen: u.firstSeen,
                lastSeen: u.lastSeen,
                lastMessage: u.lastMessage || ''
            })),
            total,
            maxPerUser: MAX_MESSAGES_PER_USER
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🚫 حظر / فك حظر مستخدم
app.post('/v1/admin/block', requireAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متصلة' });

        const { userId, block } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId مطلوب' });

        const isBlocked = block !== false; // افتراضي: حظر

        const result = await db.collection('users').updateOne(
            { userId },
            { $set: { isBlocked, blockedAt: isBlocked ? new Date() : null } },
            { upsert: true }
        );

        res.json({
            success: true,
            userId,
            isBlocked,
            message: isBlocked ? '✅ تم حظر المستخدم' : '✅ تم فك الحظر'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔄 تصفير عداد مستخدم
app.post('/v1/admin/reset', requireAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متصلة' });

        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId مطلوب' });

        await db.collection('users').updateOne(
            { userId },
            { $set: { messageCountWindow: 0, windowStart: new Date(), isBlocked: false } }
        );

        res.json({ success: true, message: '✅ تم تصفير العداد وفك الحظر' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ⚙️ حفظ إعدادات السيرفر
app.post('/v1/admin/config', requireAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متصلة' });

        const { announcement, min_supported_version } = req.body;
        const update = { updatedAt: new Date() };
        if (announcement !== undefined) update.announcement = announcement;
        if (min_supported_version !== undefined) update.min_supported_version = min_supported_version;

        await db.collection('config').updateOne(
            { key: 'general' },
            { $set: update },
            { upsert: true }
        );

        res.json({ success: true, message: '✅ تم حفظ الإعدادات' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📦 حفظ بيانات التحديث (بدون رفع APK فعلي)
app.post('/v1/admin/update', requireAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متصلة' });

        const { version_name, version_code, notes, apk_url } = req.body;

        const update = {
            key: 'update',
            version_name: version_name || '2.0.1',
            version_code: parseInt(version_code) || 201,
            notes: notes || '',
            apk_url: apk_url || '',
            updatedAt: new Date()
        };

        await db.collection('config').updateOne(
            { key: 'update' },
            { $set: update },
            { upsert: true }
        );

        res.json({
            success: true,
            message: '✅ تم حفظ بيانات التحديث',
            note: 'ملاحظة: رفع APK الفعلي غير مدعوم حاليًا. استخدم apk_url لرابط خارجي.'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 11. معلومات عامة
// ============================================================
app.get('/v1/models', (req, res) => {
    res.json({ models: Object.keys(AVAILABLE_MODELS) });
});

app.get('/', (req, res) => {
    res.json({
        status: 'Hamad Mind Server يعمل ✅',
        version: '5.0.0',
        dbConnected: !!db,
        keysLoaded: GEMINI_API_KEYS.length,
        currentKeyIndex: currentKeyIndex + 1,
        models: Object.keys(AVAILABLE_MODELS),
        features: ['chat', 'tts', 'update', 'admin', 'mongodb', 'quota', 'blocking'],
        maxPerUser: MAX_MESSAGES_PER_USER
    });
});

// ============================================================
// 12. تشغيل
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Hamad Mind Server v5.0.0 يعمل على المنفذ ${PORT}`);
    console.log(`📋 النماذج: ${Object.keys(AVAILABLE_MODELS).join(', ')}`);
    console.log(`🔊 TTS جاهز | 🛡️ Admin جاهز | 💾 MongoDB جاهز`);
    console.log(`📊 حد الرسائل: ${MAX_MESSAGES_PER_USER} رسالة / 24 ساعة`);
});