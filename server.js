const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const https = require('https');
const http = require('http');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// OpenAI клиент
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ASSISTANT_ID = process.env.ASSISTANT_ID;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Функция парсинга сайта
async function fetchWebsiteContent(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        // Простой парсинг: убираем HTML теги и берем текст
        const text = data
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        // Ищем ключевые секции
        const sections = [];
        
        // Оферта
        const offerMatch = text.match(/.{0,200}(оферта|публичная оферта|договор оферты).{0,2000}/i);
        if (offerMatch) sections.push('ОФЕРТА:\n' + offerMatch[0]);
        
        // Политика конфиденциальности
        const privacyMatch = text.match(/.{0,200}(политика конфиденциальности|обработка персональных данных|защита данных).{0,2000}/i);
        if (privacyMatch) sections.push('ПОЛИТИКА КОНФИДЕНЦИАЛЬНОСТИ:\n' + privacyMatch[0]);
        
        // Условия возврата
        const returnMatch = text.match(/.{0,200}(возврат|обмен|гарантия|возврат средств).{0,1000}/i);
        if (returnMatch) sections.push('УСЛОВИЯ ВОЗВРАТА:\n' + returnMatch[0]);
        
        if (sections.length > 0) {
          resolve(sections.join('\n\n'));
        } else {
          // Если ничего не нашли, берем первые 3000 символов
          resolve(text.substring(0, 3000));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Главный endpoint для проверки документов
app.post('/api/check-document', async (req, res) => {
  try {
    let { text, userId } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Текст документа обязателен' });
    }

    console.log(`[${new Date().toISOString()}] Проверка документа для пользователя: ${userId}`);

    // Если передан URL сайта, парсим его
    if (text.startsWith('URL: ')) {
      const url = text.replace('URL: ', '').trim();
      console.log(`Парсинг сайта: ${url}`);
      
      try {
        text = await fetchWebsiteContent(url);
        console.log(`Извлечено ${text.length} символов с сайта`);
      } catch (error) {
        console.error('Ошибка парсинга сайта:', error);
        return res.status(400).json({ 
          error: 'Не удалось загрузить содержимое сайта. Проверьте URL.' 
        });
      }
    }

    // Создаем thread
    const thread = await openai.beta.threads.create();

    // Добавляем сообщение пользователя
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: `Проверь этот документ на соответствие законам РФ:\n\n${text}`,
    });

    // Запускаем Assistant
    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: ASSISTANT_ID,
    });

    // Проверяем статус
    if (run.status === 'completed') {
      // Получаем ответ
      const messages = await openai.beta.threads.messages.list(thread.id);
      const assistantMessage = messages.data.find(
        (msg) => msg.role === 'assistant'
      );

      if (assistantMessage) {
        const response = assistantMessage.content[0].text.value;

        res.json({
          success: true,
          result: response,
          threadId: thread.id,
        });
      } else {
        throw new Error('Ответ Assistant не найден');
      }
    } else {
      throw new Error(`Run завершился со статусом: ${run.status}`);
    }
  } catch (error) {
    console.error('Ошибка при проверке документа:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint для проверки статуса Assistant
app.get('/api/assistant/status', async (req, res) => {
  try {
    const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    res.json({
      success: true,
      assistant: {
        id: assistant.id,
        name: assistant.name,
        model: assistant.model,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Обработка платежей YooKassa (webhook)
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const notification = req.body;
    
    console.log('Получен webhook от YooKassa:', notification);

    // Здесь добавь логику обработки платежа:
    // 1. Проверь подпись
    // 2. Обнови статус заказа в БД
    // 3. Отправь уведомление пользователю

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ошибка обработки webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 AI Lawyer API запущен на порту ${PORT}`);
  console.log(`📋 Assistant ID: ${ASSISTANT_ID}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
});
