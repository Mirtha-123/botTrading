const { orders } = require('./../mongo')


class OrderManager {
    constructor(price, priceSell, priceBuy, amount, commision, type, permission, status, rollback) {
        this.price = price;
        this.priceSell = priceSell;
        this.priceBuy = priceBuy;
        this.amount = amount;
        this.commision = commision;
        this.type = type;
        this.permission = permission;
        this.status = status;
        this.rollback = rollback
    }

    async save() {
        try {
            const newOrder = new orders({
                price: this.price,
                priceSell: this.priceSell,
                priceBuy: this.priceBuy,
                amount: this.amount,
                commision: this.commision,
                type: this.type,
                permission: this.permission,
                status: this.status,
                rollback: this.rollback
            });

            const savedOrder = await newOrder.save();
            console.log('Order guardado:', savedOrder);
            return savedOrder;
        } catch (err) {
            console.error('Error al guardar la orden:', err);
            throw err;
        }
    }
}

module.exports = OrderManager;