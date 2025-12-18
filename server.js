// server.js - Bot de Futuros para Telegram
const { Telegraf, Markup } = require(‘telegraf’);
const mongoose = require(‘mongoose’);
const axios = require(‘axios’);
const stripe = require(‘stripe’)(process.env.STRIPE_SECRET_KEY);

// Conexión a MongoDB
mongoose.connect(process.env.MONGODB_URI);

// Modelo de Usuario
const userSchema = new mongoose.Schema({
telegramId: { type: String, unique: true, required: true },
username: String,
balance: { type: Number, default: 0 },
energy: { type: Number, default: 60 },
level: { type: Number, default: 1 },
totalWins: { type: Number, default: 0 },
totalLosses: { type: Number, default: 0 },
betsHistory: [{
pair: String,
direction: String,
amount: Number,
result: String,
profit: Number,
timestamp: Date
}],
lastEnergyRefill: { type: Date, default: Date.now }
});

const User = mongoose.model(‘User’, userSchema);

// Modelo de Apuesta Activa
const betSchema = new mongoose.Schema({
userId: String,
pair: String,
direction: String,
amount: Number,
startPrice: Number,
startTime: Date,
endTime: Date,
status: { type: String, default: ‘active’ }
});

const Bet = mongoose.model(‘Bet’, betSchema);

const bot = new Telegraf(process.env.BOT_TOKEN);

// Función para obtener precio actual de Binance
async function getCurrentPrice(pair = ‘BTCUSDT’) {
try {
const response = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
return parseFloat(response.data.price);
} catch (error) {
console.error(‘Error obteniendo precio:’, error);
return null;
}
}

// Función para recargar energía automáticamente
async function refillEnergy(user) {
const now = new Date();
const timeDiff = now - user.lastEnergyRefill;
const minutesPassed = Math.floor(timeDiff / 60000);

if (minutesPassed > 0 && user.energy < 60) {
const energyToAdd = Math.min(minutesPassed * 1, 60 - user.energy);
user.energy += energyToAdd;
user.lastEnergyRefill = now;
await user.save();
}
return user;
}

// Comando /start
bot.start(async (ctx) => {
const telegramId = ctx.from.id.toString();

let user = await User.findOne({ telegramId });

if (!user) {
user = new User({
telegramId,
username: ctx.from.username || ctx.from.first_name,
balance: 100 // Balance inicial de 100 EUR de regalo
});
await user.save();
}

await refillEnergy(user);

const welcomeMessage = `
🎰 *Bienvenido al Bot de Futuros*

💰 Balance: ${user.balance.toFixed(2)} EUR
⚡ Energía: ${user.energy}/60
🏆 Nivel ${user.level}

Predice si el precio de BTC/USDT subirá o bajará en 10 segundos.

¡Te hemos regalado 100 EUR para empezar!
`;

await ctx.replyWithMarkdown(welcomeMessage,
Markup.inlineKeyboard([
[Markup.button.webApp(‘🎮 Abrir Mini App’, process.env.WEBAPP_URL)],
[Markup.button.callback(‘💰 Depositar’, ‘deposit’)],
[Markup.button.callback(‘📊 Mi Perfil’, ‘profile’)]
])
);
});

// Comando para ver perfil
bot.action(‘profile’, async (ctx) => {
const telegramId = ctx.from.id.toString();
let user = await User.findOne({ telegramId });

if (!user) return ctx.reply(‘Usa /start primero’);

await refillEnergy(user);

const winRate = user.totalWins + user.totalLosses > 0
? ((user.totalWins / (user.totalWins + user.totalLosses)) * 100).toFixed(2)
: 0;

const profileMessage = `
👤 *Tu Perfil*

💰 Balance: *${user.balance.toFixed(2)} EUR*
⚡ Energía: ${user.energy}/60
🏆 Nivel: ${user.level}

📊 *Estadísticas:*
✅ Victorias: ${user.totalWins}
❌ Pérdidas: ${user.totalLosses}
📈 Tasa de éxito: ${winRate}%

💎 Operaciones hasta nivel ${user.level + 1}: ${user.totalWins + user.totalLosses}/50
`;

await ctx.editMessageText(profileMessage, {
parse_mode: ‘Markdown’,
…Markup.inlineKeyboard([
[Markup.button.callback(‘🔄 Actualizar’, ‘profile’)],
[Markup.button.callback(‘📜 Historial’, ‘history’)],
[Markup.button.callback(‘◀️ Volver’, ‘back_start’)]
])
});
});

// Ver historial de apuestas
bot.action(‘history’, async (ctx) => {
const telegramId = ctx.from.id.toString();
const user = await User.findOne({ telegramId });

if (!user || user.betsHistory.length === 0) {
return ctx.editMessageText(‘No tienes historial de apuestas aún.’,
Markup.inlineKeyboard([[Markup.button.callback(‘◀️ Volver’, ‘profile’)]])
);
}

const lastBets = user.betsHistory.slice(-10).reverse();

let historyText = ‘📜 *Últimas 10 Apuestas:*\n\n’;

lastBets.forEach((bet, i) => {
const icon = bet.result === ‘win’ ? ‘✅’ : ‘❌’;
const profitText = bet.profit > 0 ? `+${bet.profit.toFixed(2)}` : bet.profit.toFixed(2);
historyText += `${icon} ${bet.pair} - ${bet.direction}\n`;
historyText += `   ${profitText} EUR\n\n`;
});

await ctx.editMessageText(historyText, {
parse_mode: ‘Markdown’,
…Markup.inlineKeyboard([[Markup.button.callback(‘◀️ Volver’, ‘profile’)]])
});
});

// Sistema de depósitos con Stripe
bot.action(‘deposit’, async (ctx) => {
await ctx.editMessageText(
‘💳 *Depositar Fondos*\n\nSelecciona la cantidad que deseas depositar:’,
{
parse_mode: ‘Markdown’,
…Markup.inlineKeyboard([
[
Markup.button.callback(‘10 EUR’, ‘deposit_10’),
Markup.button.callback(‘25 EUR’, ‘deposit_25’)
],
[
Markup.button.callback(‘50 EUR’, ‘deposit_50’),
Markup.button.callback(‘100 EUR’, ‘deposit_100’)
],
[Markup.button.callback(‘◀️ Volver’, ‘back_start’)]
])
}
);
});

// Procesar depósitos
bot.action(/deposit_(\d+)/, async (ctx) => {
const amount = parseInt(ctx.match[1]);
const telegramId = ctx.from.id.toString();

try {
// Crear sesión de pago en Stripe
const session = await stripe.checkout.sessions.create({
payment_method_types: [‘card’],
line_items: [{
price_data: {
currency: ‘eur’,
product_data: {
name: `Depósito Bot de Futuros`,
description: `Recarga de ${amount} EUR`
},
unit_amount: amount * 100
},
quantity: 1
}],
mode: ‘payment’,
success_url: `${process.env.WEBAPP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
cancel_url: `${process.env.WEBAPP_URL}/cancel`,
metadata: {
telegramId,
amount
}
});

```
await ctx.editMessageText(
  `💳 *Depósito de ${amount} EUR*\n\nHaz clic en el botón para completar el pago:`,
  {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.url('💳 Pagar con Stripe', session.url)],
      [Markup.button.callback('◀️ Volver', 'deposit')]
    ])
  }
);
```

} catch (error) {
console.error(‘Error creando sesión de pago:’, error);
await ctx.reply(‘Error al procesar el pago. Inténtalo de nuevo.’);
}
});

// Webhook de Stripe para confirmar pagos
const express = require(‘express’);
const app = express();

app.post(’/webhook/stripe’, express.raw({type: ‘application/json’}), async (req, res) => {
const sig = req.headers[‘stripe-signature’];
let event;

try {
event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
} catch (err) {
return res.status(400).send(`Webhook Error: ${err.message}`);
}

if (event.type === ‘checkout.session.completed’) {
const session = event.data.object;
const { telegramId, amount } = session.metadata;

```
// Actualizar balance del usuario
const user = await User.findOne({ telegramId });
if (user) {
  user.balance += parseFloat(amount);
  await user.save();
  
  // Notificar al usuario
  await bot.telegram.sendMessage(telegramId, 
    `✅ ¡Depósito exitoso!\n\n💰 +${amount} EUR añadidos a tu cuenta.\n💵 Nuevo balance: ${user.balance.toFixed(2)} EUR`
  );
}
```

}

res.json({received: true});
});

// Volver al inicio
bot.action(‘back_start’, async (ctx) => {
const telegramId = ctx.from.id.toString();
let user = await User.findOne({ telegramId });
await refillEnergy(user);

const welcomeMessage = `
🎰 *Bot de Futuros*

💰 Balance: ${user.balance.toFixed(2)} EUR
⚡ Energía: ${user.energy}/60
🏆 Nivel ${user.level}
`;

await ctx.editMessageText(welcomeMessage, {
parse_mode: ‘Markdown’,
…Markup.inlineKeyboard([
[Markup.button.webApp(‘🎮 Abrir Mini App’, process.env.WEBAPP_URL)],
[Markup.button.callback(‘💰 Depositar’, ‘deposit’)],
[Markup.button.callback(‘📊 Mi Perfil’, ‘profile’)]
])
});
});

// API para la Mini App
app.use(express.json());

// Obtener datos del usuario
app.get(’/api/user/:telegramId’, async (req, res) => {
try {
let user = await User.findOne({ telegramId: req.params.telegramId });
if (!user) {
return res.status(404).json({ error: ‘Usuario no encontrado’ });
}
await refillEnergy(user);
res.json(user);
} catch (error) {
res.status(500).json({ error: error.message });
}
});

// Crear apuesta
app.post(’/api/bet’, async (req, res) => {
const { telegramId, direction, amount } = req.body;

try {
const user = await User.findOne({ telegramId });

```
if (!user) {
  return res.status(404).json({ error: 'Usuario no encontrado' });
}

await refillEnergy(user);

if (user.energy < 1) {
  return res.status(400).json({ error: 'Sin energía suficiente' });
}

if (user.balance < amount) {
  return res.status(400).json({ error: 'Balance insuficiente' });
}

const currentPrice = await getCurrentPrice('BTCUSDT');

const bet = new Bet({
  userId: telegramId,
  pair: 'BTC/USDT',
  direction,
  amount,
  startPrice: currentPrice,
  startTime: new Date(),
  endTime: new Date(Date.now() + 10000) // 10 segundos
});

await bet.save();

user.balance -= amount;
user.energy -= 1;
await user.save();

res.json({ 
  success: true, 
  bet,
  currentPrice,
  user: {
    balance: user.balance,
    energy: user.energy
  }
});
```

} catch (error) {
res.status(500).json({ error: error.message });
}
});

// Resolver apuesta
app.post(’/api/bet/resolve/:betId’, async (req, res) => {
try {
const bet = await Bet.findById(req.params.betId);

```
if (!bet || bet.status !== 'active') {
  return res.status(400).json({ error: 'Apuesta no válida' });
}

const finalPrice = await getCurrentPrice('BTCUSDT');
const priceChange = finalPrice - bet.startPrice;

let won = false;
if (bet.direction === 'ALCISTA' && priceChange > 0) won = true;
if (bet.direction === 'BAJISTA' && priceChange < 0) won = true;

const profit = won ? bet.amount * 0.85 : -bet.amount; // 85% de ganancia

const user = await User.findOne({ telegramId: bet.userId });
user.balance += bet.amount + profit;

if (won) {
  user.totalWins += 1;
} else {
  user.totalLosses += 1;
}

// Sistema de niveles
const totalOps = user.totalWins + user.totalLosses;
user.level = Math.floor(totalOps / 50) + 1;

user.betsHistory.push({
  pair: bet.pair,
  direction: bet.direction,
  amount: bet.amount,
  result: won ? 'win' : 'loss',
  profit,
  timestamp: new Date()
});

await user.save();

bet.status = 'resolved';
await bet.save();

res.json({
  success: true,
  won,
  profit,
  finalPrice,
  priceChange: ((priceChange / bet.startPrice) * 100).toFixed(2),
  user: {
    balance: user.balance,
    energy: user.energy,
    level: user.level,
    totalWins: user.totalWins,
    totalLosses: user.totalLosses
  }
});
```

} catch (error) {
res.status(500).json({ error: error.message });
}
});

// Obtener precio actual
app.get(’/api/price/:pair’, async (req, res) => {
const price = await getCurrentPrice(req.params.pair.replace(’-’, ‘’));
res.json({ price });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log(`Servidor corriendo en puerto ${PORT}`);
});

bot.launch();

process.once(‘SIGINT’, () => bot.stop(‘SIGINT’));
process.once(‘SIGTERM’, () => bot.stop(‘SIGTERM’));
