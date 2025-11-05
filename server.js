import express from 'express';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === ENV ===
const {
  APP_BASE_URL,                // https://pay.cinq.com.ua (или временно vercel url)
  SHOPIFY_STORE_DOMAIN,        // 2szizg-0m.myshopify.com
  SHOPIFY_ACCESS_TOKEN,        // Admin API access token
  SHOPIFY_API_VERSION = '2023-10',
  MONO_TOKEN,                  // X-Token из Plata by Mono
  CURRENCY = 'UAH',            // UAH
  DEPOSIT_PERCENT = '20',      // предоплата в %
  GATEWAY_NAME = 'Plata by Mono | оплата карткою'
} = process.env;

// Вспомогательно
const moneyToMinor = (amountStr) => {
  // "1234.56" -> 123456 (копейки)
  const n = Number.parseFloat(amountStr);
  return Math.round(n * 100);
};

const minorToMoney = (minor) => (minor / 100).toFixed(2);

// 1) Страница/ендпоинт для старта оплаты
// GET /pay?order_id=...&mode=full|deposit
app.get('/pay', async (req, res) => {
  try {
    const { order_id, mode = 'full' } = req.query;
    if (!order_id) return res.status(400).send('order_id is required');

    // 1.1 Получаем заказ из Shopify
    const orderResp = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${order_id}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!orderResp.ok) {
      const t = await orderResp.text();
      return res.status(500).send(`Shopify order fetch error: ${t}`);
    }
    const { order } = await orderResp.json();

    // 1.2 Считаем сумму
    const totalMinor = moneyToMinor(order.total_price);
    let payMinor = totalMinor;

    if (mode === 'deposit') {
      const perc = Math.max(1, Math.min(100, Number(DEPOSIT_PERCENT)));
      payMinor = Math.ceil(totalMinor * (perc / 100));
    }

    // 1.3 Создаём инвойс в Mono (Plata by Mono)
    // Внимание: ниже — типовое тело. У вас в кабинете могут отличаться поля.
    const monoCreateInvoiceUrl = 'https://api.monobank.ua/api/merchant/invoice/create';

    // UAH -> ccy 980
    const ccy = 980;

    const payload = {
      amount: payMinor,                    // в копейках
      ccy,                                 // 980
      merchantPaymInfo: {
        reference: `shopify_order_${order.id}_${Date.now()}`,
        destination: `Оплата заказа #${order.name} (${mode === 'deposit' ? 'предоплата' : 'полная'})`
      },
      redirectUrl: `${APP_BASE_URL}/mono/return?order_id=${order.id}`,
      webHookUrl: `${APP_BASE_URL}/mono/webhook`,
      validity: 86400                      // 24 часа (сек)
    };

    const monoResp = await fetch(monoCreateInvoiceUrl, {
      method: 'POST',
      headers: {
        'X-Token': MONO_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!monoResp.ok) {
      const t = await monoResp.text();
      return res.status(500).send(`Mono create invoice error: ${t}`);
    }

    const monoData = await monoResp.json();
    // По контракту у monobank будет что-то вроде pageUrl / invoiceId
    const { pageUrl, invoiceId } = monoData;

    // Сохранять invoiceId где-то персистентно мы не можем в serverless,
    // поэтому передадим его через query (а подтверждение доверим вебхуку)
    const backUrl = `${pageUrl}`;
    return res.redirect(backUrl);

  } catch (e) {
    console.error(e);
    return res.status(500).send('Internal error');
  }
});

// 2) Возврат пользователя (не критично для учёта)
app.get('/mono/return', async (req, res) => {
  const { order_id } = req.query;
  // Можно показать простую страницу «Спасибо» и кнопку «Посмотреть заказ»
  return res.send(`
    <html>
      <head><meta charset="utf-8"/></head>
      <body style="font-family:system-ui;padding:24px">
        <h2>Спасибо! Если оплата прошла, статус заказа обновится в течение минуты.</h2>
        <p><a href="https://${SHOPIFY_STORE_DOMAIN}/account">Мои заказы</a></p>
      </body>
    </html>
  `);
});

// 3) Вебхук от monobank — тут отмечаем платеж в Shopify
app.post('/mono/webhook', async (req, res) => {
  try {
    const event = req.body;
    // Примерная структура: уточните в Plata by Mono (обычно есть fields: invoiceId, status, amount, reference)
    // Здесь важны: reference (мы туда вложили order_id), amount (в копейках), status == 'success'/'holded'/...
    const { invoiceId, status, amount, merchantPaymInfo } = event;
    const reference = merchantPaymInfo?.reference || '';

    const m = reference.match(/shopify_order_(\d+)_/);
    if (!m) {
      console.log('Webhook: reference parse failed', reference);
      return res.status(200).end();
    }
    const orderId = m[1];

    // Успешные статусы — отметим транзакцию
    const success = ['success', 'hold', 'approved', 'processed'].includes(
      String(status).toLowerCase()
    );
    if (!success) {
      console.log('Webhook non-success status:', status);
      return res.status(200).end();
    }

    // Создаём транзакцию в Shopify
    const money = minorToMoney(amount); // строка "123.45"

    const txPayload = {
      transaction: {
        kind: "sale",
        status: "success",
        amount: money,
        currency: CURRENCY,
        gateway: GATEWAY_NAME,
        source: "external",
        // message и metadata — опционально
        message: `Mono invoice ${invoiceId}`
      }
    };

    const txResp = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/transactions.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(txPayload)
      }
    );

    if (!txResp.ok) {
      const t = await txResp.text();
      console.error('Shopify transaction create error', t);
      return res.status(500).send('Shopify transaction error');
    }

    console.log('Transaction created for order', orderId, 'amount', money);
    return res.status(200).end();

  } catch (e) {
    console.error(e);
    return res.status(500).end();
  }
});

// healthcheck
app.get('/', (_, res) => res.send('cinq-monobank-pay OK'));

export default app;
