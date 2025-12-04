const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Увеличиваем лимит для больших документов

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Системный промпт для AI Юриста
const SYSTEM_PROMPT = `Ты — старший Compliance-аудитор РФ с 20-летним стажем. Проверь документ на соответствие законам РФ.

ПРОВЕРЯЕМ:
1. ФЗ-152 "О персональных данных"
2. Закон "О защите прав потребителей"
3. ФЗ-38 "О рекламе"
4. ГК РФ (договорные условия)

ФОРМАТ ОТВЕТА:

🚨 УРОВЕНЬ РИСКА: [КРИТИЧЕСКИЙ / ВЫСОКИЙ / СРЕДНИЙ / НИЗКИЙ]

---

❌ НАРУШЕНИЯ:

1. [Название нарушения]
Цитата: "..."
Нарушает: [Статья закона]
Штраф: [Сумма] для ИП / [Сумма] для ЮЛ
Как исправить: [Инструкция]

---

✅ РЕКОМЕНДАЦИИ:
1. [Конкретная рекомендация]
2. [Конкретная рекомендация]

---

DISCLAIMER: Это автоматический анализ. Проконсультируйтесь с юристом.`;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Функция очистки и нормализации текста
function cleanText(text) {
  return text
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, '') // Удаляем control characters
    .replace(/[\u2028\u2029]/g, ' ') // Заменяем line/paragraph separators
    .replace(/\r\n/g, '\n') // Нормализуем переносы строк
    .replace(/\r/g, '\n')
    .trim();
}

// Функция парсинга сайта
async function fetchWebsiteContent(url) {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    const protocol = url.startsWith('https') ? https : http;
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };
    
    protocol.get(url, options, (res) => {
      let data = '';
      
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchWebsiteContent(res.headers.location).then(resolve).catch(reject);
      }
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const text = data
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        const sections = [];
        
        const offerMatch = text.match(/.{0,300}(оферта|публичная оферта|договор оферты|пользовательское соглашение).{0,3000}/i);
        if (offerMatch) sections.push('ОФЕРТА:\n' + offerMatch[0]);
        
        const privacyMatch = text.match(/.{0,300}(политика конфиденциальности|обработка персональных данных|защита данных).{0,3000}/i);
        if (privacyMatch) sections.push('\n\nПОЛИТИКА:\n' + privacyMatch[0]);
        
        const returnMatch = text.match(/.{0,300}(возврат|обмен|гарантия).{0,1500}/i);
        if (returnMatch) sections.push('\n\nВОЗВРАТ:\n' + returnMatch[0]);
        
        if (sections.length > 0) {
          resolve(cleanText(sections.join('\n')));
        } else {
          resolve(cleanText('СОДЕРЖИМОЕ:\n' + text.substring(0, 4000)));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Функция вызова Groq API
async function callGroqAPI(userMessage) {
  return new Promise((resolve, reject) => {
    // Очищаем текст перед отправкой
    const cleanedMessage = cleanText(userMessage);
    
    // Ограничиваем размер сообщения
    const truncatedMessage = cleanedMessage.length > 12000 
      ? cleanedMessage.substring(0, 12000) + '\n\n[Текст обрезан]'
      : cleanedMessage;

    const payload = {
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT
        },
        {
          role: "user",
          content: truncatedMessage
        }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      top_p: 0.9
    };

    const data = JSON.stringify(payload);

    const options = {
      hostname: 'api.groq.com',
      port: 443,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    console.log('Отправка запроса к Groq API...');
    console.log('Размер payload:', Buffer.byteLength(data), 'байт');

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        console.log('Получен ответ от Groq. Status:', res.statusCode);

        try {
          const parsed = JSON.parse(responseData);
          
          if (parsed.error) {
            console.error('Groq API error:', parsed.error);
            reject(new Error(`Groq API: ${parsed.error.message}`));
            return;
          }

          if (!parsed.choices?.[0]?.message?.content) {
            console.error('Неверная структура:', parsed);
            reject(new Error('Неверный ответ от Groq'));
            return;
          }

          console.log('✅ Успешно получен ответ');
          resolve(parsed.choices[0].message.content);

        } catch (error) {
          console.error('Ошибка парсинга:', error);
          console.error('Сырой ответ:', responseData.substring(0, 500));
          reject(new Error('Ошибка парсинга ответа: ' + error.message));
        }
      });
    });

    req.on('error', (error) => {
      console.error('Ошибка запроса:', error);
      reject(new Error('Ошибка соединения: ' + error.message));
    });

    req.write(data);
    req.end();
  });
}

// Главный endpoint для проверки документов
app.post('/api/check-document', async (req, res) => {
  try {
    let { text, userId } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Текст документа обязателен' });
    }

    console.log(`[${new Date().toISOString()}] Проверка для: ${userId}`);

    // Если передан URL сайта, парсим его
    if (text.startsWith('URL: ')) {
      const url = text.replace('URL: ', '').trim();
      console.log(`Парсинг: ${url}`);
      
      try {
        text = await fetchWebsiteContent(url);
        console.log(`Извлечено ${text.length} символов`);
        
        if (text.length < 100) {
          return res.status(400).json({ 
            error: 'На сайте слишком мало текста. Попробуйте вставить текст вручную.' 
          });
        }
      } catch (error) {
        console.error('Ошибка парсинга:', error);
        return res.status(400).json({ 
          error: 'Не удалось загрузить сайт. Попробуйте вставить текст вручную.' 
        });
      }
    }

    // Очищаем и проверяем текст
    text = cleanText(text);
    
    if (text.length < 50) {
      return res.status(400).json({ 
        error: 'Текст слишком короткий. Минимум 50 символов.' 
      });
    }

    // Вызываем Groq API
    const userMessage = `Проверь документ на compliance с законами РФ:\n\n${text}`;
    const aiResponse = await callGroqAPI(userMessage);

    res.json({
      success: true,
      result: aiResponse,
    });

  } catch (error) {
    console.error('Ошибка при проверке:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Неизвестная ошибка',
    });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 AI Lawyer API (Groq) на порту ${PORT}`);
  console.log(`🔑 API Key: ${GROQ_API_KEY ? '✅ установлен' : '❌ НЕ УСТАНОВЛЕН'}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
});
