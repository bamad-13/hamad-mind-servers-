// ============================================================
// Hamad Mind Server v2.0.0
// تدوير المفاتيح + حفظ التاريخ + ذاكرة المستخدم + اختيار النموذج
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

// ---------- قراءة المفاتيح من متغيرات البيئة ----------
const RAW_KEYS = process.env.GEMINI_API_KEYS || '';
const GEMINI_API_KEYS = RAW_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0);

if (GEMINI_API_KEYS.length === 0) {
    console.error('❌ GEMINI_API_KEYS غير موجود في متغيرات البيئة');
    process.exit(1);
}
console.log(`✅ تم تحميل ${GEMINI_API_KEYS.length} مفتاح`);

let currentKeyIndex = 0;

function getCurrentKey() {
    return GEMINI_API_KEYS[currentKeyIndex];
}

function switchToNextKey() {
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
    console.log(`🔄 التبديل إلى المفتاح رقم ${currentKeyIndex + 1}`);
}

function createClient() {
    return new GoogleGenAI({ apiKey: getCurrentKey() });
}

// ---------- النماذج المتاحة (أسماء موثوقة من Google) ----------
const AVAILABLE_MODELS = {
    'flash':        'gemini-2.5-flash',
    'flash-lite':   'gemini-2.5-flash-lite',
    'flash-2.0':    'gemini-2.0-flash',
    'flash-1.5':    'gemini-1.5-flash'
};

function resolveModel(key) {
    return AVAILABLE_MODELS[key] || 'gemini-2.5-flash';
}

// ---------- إدارة الملفات ----------
function loadJSON(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { console.error('قراءة فاشلة:', e.message); }
    return fallback;
}

function saveJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
    catch (e) { console.error('كتابة فاشلة:', e.message); }
}

// ---------- استدعاء Gemini مع تبديل المفاتيح تلقائيًا ----------
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
// المسار الرئيسي: المحادثة
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

        const reply = await callGeminiWithRetry(
            model || 'flash',
            contents,
            systemPrompt || null
        );

        // حفظ في السجل
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

// ---------- مسار التحديث (يتوافق مع كودك) ----------
app.get('/v1/update', (req, res) => {
    res.json({
        version_code: 201,
        version_name: '2.0.1',
        apk_url: '',
        notes: 'لا يوجد تحديث حالي'
    });
});

// ---------- مسار الصور (قيد التطوير) ----------
app.post('/v1/image', (req, res) => {
    res.status(501).json({ error: 'توليد الصور غير مهيأ بعد' });
});

// ---------- معلومات ----------
app.get('/v1/models', (req, res) => {
    res.json({ models: Object.keys(AVAILABLE_MODELS) });
});

app.get('/', (req, res) => {
    res.json({
        status: 'Hamad Mind Server يعمل ✅',
        keysLoaded: GEMINI_API_KEYS.length,
        currentKeyIndex: currentKeyIndex + 1,
        models: Object.keys(AVAILABLE_MODELS)
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
});