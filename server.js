// ============================================================
// Hamad Mind Server v4.0.0
// Chat + TTS + Update + Admin Panel + تدوير المفاتيح
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// ---------- المسارات ----------
const HISTORY_FILE = path.join(__dirname, 'gemini_chat_history.json');
const CONFIG_FILE  = path.join(__dirname, 'server_config.json');

// ---------- إعدادات Admin ----------
// ضع التوكن في Environment Variable على Render باسم ADMIN_TOKEN
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'hamad_admin_2026';

// ---------- قراءة المفاتيح ----------
const RAW_KEYS = process.env.GEMINI_API_KEYS || '';
const GEMINI_API_KEYS = RAW_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0);

if (GEMINI_API_KEYS.length === 0) {
    console.error('❌ GEMINI_API_KEYS غير موجود في متغيرات البيئة');
    process.exit(1);
}
console.log(`✅ تم تحميل ${GEMINI_API_KEYS.length} مفتاح`);
console.log(`🔐 ADMIN_TOKEN مُهيأ`);

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

// ---------- إدارة الملفات ----------
function loadJSON(file, fallback) {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error('قراءة فاشلة:', e.message); }
    return fallback;
}
function saveJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
    catch (e) { console.error('كتابة فاشلة:', e.message); }
}

// ---------- Middleware للتحقق من Admin ----------
function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.body.adminToken || req.query.token;
    if (!token || token !== ADMIN_TOKEN) {
        return res.status(401).json({ error: 'غير مصرح — توكن Admin غير صحيح' });
    }
    next();
}

// ---------- استدعاء Gemini مع تبديل المفاتيح ----------
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
    throw new Error('فشلت جميع المفاتيح: ' + (lastError ? lastError.message : 'خطأ غير معروف'));
}

// ============================================================
// 1. مسار المحادثة
// ============================================================
app.post('/v1/chat', async (req, res) => {
    try {
        const { message, history, model, userId, systemPrompt } = req.body;
        if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });

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

        const reply = await callGeminiWithRetry(model || 'flash', contents, systemPrompt || null);

        const historyData = loadJSON(HISTORY_FILE, []);
        historyData.push({
            userId: userId || 'anonymous',
            user: message,
            ai: reply,
            model: resolveModel(model || 'flash'),
            time: new Date().toISOString()
        });
        if (historyData.length > 1000) historyData.splice(0, historyData.length - 1000);
        saveJSON(HISTORY_FILE, historyData);

        res.json({ reply: reply, usedModel: resolveModel(model || 'flash') });
    } catch (error) {
        console.error('❌ /v1/chat:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 2. مسار TTS
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
                if (!audioBase64) throw new Error('لم يتم العثور على بيانات صوتية');

                return res.json({ data: audioBase64, mimeType: 'audio/wav', voice: voice || 'Kore' });
            } catch (error) {
                lastError = error;
                console.warn(`⚠️ فشل TTS بالمفتاح ${currentKeyIndex + 1}: ${error.message}`);
                switchToNextKey();
            }
        }
        throw new Error('فشلت جميع المفاتيح في TTS: ' + (lastError ? lastError.message : 'خطأ'));
    } catch (error) {
        console.error('❌ /v1/tts:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 3. مسار التحديث
// ============================================================
app.get('/v1/update', (req, res) => {
    const config = loadJSON(CONFIG_FILE, {});
    res.json({
        version_code: config.version_code || 201,
        version_name: config.version_name || '2.0.1',
        apk_url: config.apk_url || '',
        notes: config.notes || 'لا يوجد تحديث حالي'
    });
});

// ============================================================
// 4. مسار الصور (قيد التطوير)
// ============================================================
app.post('/v1/image', (req, res) => {
    res.status(501).json({ error: 'توليد الصور غير مهيأ بعد' });
});

// ============================================================
// 5. لوحة التحكم — ADMIN APIs
// ============================================================

// 📊 إحصائيات
app.get('/v1/admin/stats', requireAdmin, (req, res) => {
    const history = loadJSON(HISTORY_FILE, []);
    const users = new Set(history.map(h => h.userId)).size;
    const totalMessages = history.length;
    const last24h = history.filter(h => {
        const diff = Date.now() - new Date(h.time).getTime();
        return diff < 24 * 60 * 60 * 1000;
    }).length;

    res.json({
        totalUsers: users,
        totalMessages: totalMessages,
        messagesLast24h: last24h,
        keysLoaded: GEMINI_API_KEYS.length,
        currentKeyIndex: currentKeyIndex + 1,
        serverVersion: '4.0.0',
        timestamp: new Date().toISOString()
    });
});

// 👥 آخر المستخدمين
app.get('/v1/admin/users', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const history = loadJSON(HISTORY_FILE, []);

    // نجمع آخر رسالة لكل مستخدم
    const usersMap = {};
    history.forEach(h => {
        const uid = h.userId || 'anonymous';
        if (!usersMap[uid]) {
            usersMap[uid] = {
                userId: uid,
                firstSeen: h.time,
                lastSeen: h.time,
                messageCount: 0,
                lastMessage: ''
            };
        }
        usersMap[uid].lastSeen = h.time;
        usersMap[uid].messageCount++;
        usersMap[uid].lastMessage = h.user;
    });

    const usersArray = Object.values(usersMap)
        .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
        .slice(0, limit);

    res.json({ users: usersArray, total: Object.keys(usersMap).length });
});

// ⚙️ حفظ إعدادات السيرفر (config)
app.post('/v1/admin/config', requireAdmin, (req, res) => {
    try {
        const { announcement, min_supported_version } = req.body;
        const config = loadJSON(CONFIG_FILE, {});
        if (announcement !== undefined) config.announcement = announcement;
        if (min_supported_version !== undefined) config.min_supported_version = min_supported_version;
        config.updatedAt = new Date().toISOString();
        saveJSON(CONFIG_FILE, config);
        res.json({ success: true, message: 'تم حفظ الإعدادات', config: config });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📦 رفع تحديث APK (نسخة مبسطة — ترجع نجاح بدون رفع فعلي)
app.post('/v1/admin/update', requireAdmin, (req, res) => {
    try {
        // ملاحظة: رفع APK يحتاج multer أو تخزين خارجي
        // هذا رد مؤقت حتى نُعدّ الرفع الفعلي لاحقًا
        const config = loadJSON(CONFIG_FILE, {});
        config.version_name = req.body.version_name || config.version_name;
        config.version_code = parseInt(req.body.version_code) || config.version_code;
        config.notes = req.body.notes || config.notes;
        config.updatedAt = new Date().toISOString();
        saveJSON(CONFIG_FILE, config);

        res.json({
            success: true,
            message: 'تم استلام بيانات التحديث (بدون رفع APK فعلي بعد)',
            config: config
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 6. معلومات عامة
// ============================================================
app.get('/v1/models', (req, res) => {
    res.json({ models: Object.keys(AVAILABLE_MODELS) });
});

app.get('/', (req, res) => {
    res.json({
        status: 'Hamad Mind Server يعمل ✅',
        version: '4.0.0',
        keysLoaded: GEMINI_API_KEYS.length,
        currentKeyIndex: currentKeyIndex + 1,
        models: Object.keys(AVAILABLE_MODELS),
        features: ['chat', 'tts', 'update', 'admin']
    });
});

// ---------- تشغيل ----------
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Hamad Mind Server v4.0.0 يعمل على المنفذ ${PORT}`);
    console.log(`📋 النماذج: ${Object.keys(AVAILABLE_MODELS).join(', ')}`);
    console.log(`🔊 TTS جاهز | 🛡️ Admin جاهز`);
});