require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// OpenAI клиент
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ID ассистента (создашь на platform.openai.com)
const ASSISTANT_ID = process.env.ASSISTANT_ID;

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Основной endpoint проверки документа
app.post('/api/check', async (req, res) => {
    try {
        const { text, userId } = req.body;

        if (!text || text.length < 100) {
            return res.status(400).json({ 
                error: 'Текст слишком короткий. Минимум 100 символов.' 
            });
        }

        console.log(`[${new Date().toISOString()}] Начало проверки для пользователя ${userId}`);

        // 1. Создаем Thread
        const thread = await openai.beta.threads.create();
        console.log(`Thread создан: ${thread.id}`);

        // 2. Добавляем сообщение пользователя
        await openai.beta.threads.messages.create(thread.id, {
            role: 'user',
            content: `Проанализируй следующий документ на соответствие законодательству РФ:\n\n${text}`
        });

        // 3. Запускаем ассистента
        const run = await openai.beta.threads.runs.create(thread.id, {
            assistant_id: ASSISTANT_ID
        });
        console.log(`Run запущен: ${run.id}`);

        // 4. Ждем завершения (polling)
        let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        let attempts = 0;
        const maxAttempts = 60; // максимум 60 секунд

        while (runStatus.status !== 'completed' && attempts < maxAttempts) {
            if (runStatus.status === 'failed' || runStatus.status === 'cancelled' || runStatus.status === 'expired') {
                throw new Error(`Run завершился со статусом: ${runStatus.status}`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000)); // ждем 1 секунду
            runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
            attempts++;
            
            if (attempts % 5 === 0) {
                console.log(`Ожидание... статус: ${runStatus.status} (${attempts}s)`);
            }
        }

        if (runStatus.status !== 'completed') {
            throw new Error('Превышено время ожидания ответа AI');
        }

        console.log('Run завершен успешно');

        // 5. Получаем ответ
        const messages = await openai.beta.threads.messages.list(thread.id);
        const lastMessage = messages.data[0];
        const result = lastMessage.content[0].text.value;

        console.log(`Результат получен, длина: ${result.length} символов`);

        // Возвращаем результат
        res.json({
            success: true,
            result: result,
            threadId: thread.id
        });

    } catch (error) {
        console.error('Ошибка при проверке документа:', error);
        res.status(500).json({ 
            error: 'Ошибка при обработке запроса',
            details: error.message 
        });
    }
});

// Endpoint для создания платежа (для будущего)
app.post('/api/create-payment', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        
        // TODO: Интеграция с YooKassa
        // Логика как в Lucky Style
        
        res.json({
            success: true,
            paymentUrl: 'https://yookassa.ru/...',
            message: 'Платежная ссылка создана'
        });
    } catch (error) {
        console.error('Ошибка создания платежа:', error);
        res.status(500).json({ error: 'Ошибка создания платежа' });
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 AI Lawyer API запущен на порту ${PORT}`);
    console.log(`📡 Health check: http://localhost:${PORT}/health`);
    console.log(`🤖 OpenAI Assistant ID: ${ASSISTANT_ID}`);
});

module.exports = app;
