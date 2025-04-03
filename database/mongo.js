// app.js
require('dotenv').config();
const mongoose = require('mongoose');

// Conectar a MongoDB
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Conectado a MongoDB'))
  .catch(err => console.error('Error al conectar a MongoDB', err));

// Definir el esquema
const orderSchema = new mongoose.Schema({
  price: { type: Number, required: true },
  priceSell: { type: Number },
  priceBuy: { type: Number },
  amount: { type: Number },
  commision: { type: Number },
  status: { type: Number },
  type: { type: String, default: 0 },
  permission: { type: mongoose.Schema.Types.ObjectId, ref: 'permissions' },
  createdAt: { type: Date, default: Date.now },
  rollback: { type: Number },
});

// Definir el esquema
const permissionsSchema = new mongoose.Schema({
  status: { type: Number, required: true },
  amount: { type: Number, required: true },
  coin: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Crear el modelo
const permissions = mongoose.model('permissions', permissionsSchema);

// Crear el modelo
const orders = mongoose.model('orders', orderSchema);

module.exports = { orders, permissions };