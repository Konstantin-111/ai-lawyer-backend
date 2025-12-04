const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Системный промпт для AI Юриста
const SYSTEM_PROMPT = `Ты — **Старший Compliance-аудитор РФ** с 20-летним стажем, специализируешься на проверке документов на соответствие законам РФ.

**GROUNDING ПРАВИЛО:** Используй ТОЛЬКО информацию из загруженных законов РФ. Если информации нет — НЕ придумывай, скажи "требуется консультация с юристом".

**ТВОЯ ЗАДАЧА:** Проверить документ на соответствие:
1. **ФЗ-152 "О персональных данных"** — согласие, обработка, передача ПДн
2. **Закон "О защите прав потребителей"** — возврат, гарантии, сроки
3. **ФЗ-38 "О рекламе"** — запрещенные заявления, обязательные пометки
4. **ГК РФ** — оферта, акцепт, существенные условия

**ФОРМАТ ОТВЕТА:**

🚨 **УРОВЕНЬ РИСКА:** [КРИТИЧЕСКИЙ / ВЫСОКИЙ / СРЕДНИЙ / НИЗКИЙ]

---

❌ **НАРУШЕНИЯ:**

**1. [Название нарушения]**
📜 Цитата из документа: "..."
⚖️ Нарушает: [Статья закона]
💰 Возможный штраф: [Сумма] для ИП / [Сумма] для ЮЛ
🔧 Как исправить: [Конкретная инструкция]

[Повторить для каждого нарушения]

---

✅ **РЕКОМЕНДАЦИИ:**
1. [Конкретная рекомендация]
2. [Конкретная рекомендация]

---

⚖️ **DISCLAIMER:** Это автоматический анализ. Для юридически значимых решений проконсультируйтесь с квалифицированным юристом.

**ТОН:** Строгий, предупреждающий, но конструктивный. Без лишних слов.`;

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Функция парсинга сайта
async function fetchWebsiteContent(url) {
  return new Promise((resolve, reject) => {
    // Добавляем http:// если не указан протокол
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
      
      // Следуем за редиректами
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchWebsiteContent(res.headers.location).then(resolve).catch(reject);
      }
      
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
        const offerMatch = text.match(/.{0,300}(оферта|публичная оферта|договор оферты|пользовательское соглашение).{0,3000}/i);
        if (offerMatch) sections.push('ОФЕРТА/СОГЛАШЕНИЕ:\n' + offerMatch[0]);
        
        // Политика конфиденциальности
        const privacyMatch = text.match(/.{0,300}(политика конфиденциальности|обработка персональных данных|защита данных|согласие на обработку).{0,3000}/i);
        if (privacyMatch) sections.push('\n\nПОЛИТИКА КОНФИДЕНЦИАЛЬНОСТИ:\n' + privacyMatch[0]);
        
        // Условия возврата
        const returnMatch = text.match(/.{0,300}(возврат|обмен|гарантия|возврат средств|условия возврата).{0,1500}/i);
        if (returnMatch) sections.push('\n\nУСЛОВИЯ ВОЗВРАТА:\n' + returnMatch[0]);
        
        if (sections.length > 0) {
          resolve(sections.join('\n'));
        } else {
          // Если ничего не нашли, берем первые 4000 символов
          resolve('СОДЕРЖИМОЕ САЙТА:\n' + text.substring(0, 4000));
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
    const data = JSON.stringify({
      model: "llama-3.3-70b-versatile", // Или "mixtral-8x7b-32768"
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      top_p: 0.9
    });

    const options = {
      hostname: 'api.groq.com',
      port: 443,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
            resolve(parsed.choices[0].message.content);
          } else {
            reject(new Error('Неверный формат ответа от Groq'));
          }
        } catch (error) {
          reject(new Error('Ошибка парсинга ответа: ' + error.message));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
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

    console.log(`[${new Date().toISOString()}] Проверка документа для пользователя: ${userId}`);

    // Если передан URL сайта, парсим его
    if (text.startsWith('URL: ')) {
      const url = text.replace('URL: ', '').trim();
      console.log(`Парсинг сайта: ${url}`);
      
      try {
        text = await fetchWebsiteContent(url);
        console.log(`Извлечено ${text.length} символов с сайта`);
        
        if (text.length < 100) {
          return res.status(400).json({ 
            error: 'На сайте слишком мало текста. Попробуйте другой URL или вставьте текст вручную.' 
          });
        }
      } catch (error) {
        console.error('Ошибка парсинга сайта:', error);
        return res.status(400).json({ 
          error: 'Не удалось загрузить содержимое сайта. Проверьте URL или попробуйте вставить текст вручную.' 
        });
      }
    }

    // Вызываем Groq API
    const userMessage = `Проверь этот документ на соответствие законам РФ:\n\n${text}`;
    const aiResponse = await callGroqAPI(userMessage);

    res.json({
      success: true,
      result: aiResponse,
    });

  } catch (error) {
    console.error('Ошибка при проверке документа:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 AI Lawyer API (Groq) запущен на порту ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
});
