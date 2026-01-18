import { setGlobalOptions } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import cors from "cors";

setGlobalOptions({ maxInstances: 10 });

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://piter-east-default-rtdb.firebaseio.com",
  });
}

const rtdb = admin.database();
const corsHandler = cors({ origin: true });

/**
 * Helpers
 */

function nowTs() {
  return (admin as any)?.database?.ServerValue?.TIMESTAMP ?? Date.now();
}

function calcTotals(
  itemsObj: Record<string, any>,
  deliveryFee: number = 0,
  discount: number = 0
) {
  const items = Object.values(itemsObj || {}) as any[];

  let subtotal = 0;

  for (const it of items) {
    const qty = Number(it?.quantity || 0);
    const unit = Number(it?.unitPrice || 0);
    const expectedTotal = qty * unit;

    it.totalPrice = expectedTotal;
    subtotal += expectedTotal;
  }

  const total = Math.max(0, subtotal + Number(deliveryFee || 0) - Number(discount || 0));

  return {
    subtotal,
    deliveryFee: Number(deliveryFee || 0),
    discount: Number(discount || 0),
    total,
    currency: "MXN",
  };
}

function isCancellable(status: any) {
  return ["created", "confirmed"].includes(String(status || ""));
}

/**
 * POST /createOrderDelivery
 */
export const createOrderDelivery = onRequest(async (req: any, res: any) => {
  corsHandler(req, res, async () => {
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const body = (req.body || {}) as Record<string, any>;
      const {
        userId,
        localId,
        zoneId,
        zoneName,
        location,
        items,
        payment,
        deliveryFee,
        discount,
        customerSnapshot,
        localSnapshot,
      } = body;

      if (!userId) return res.status(400).json({ error: "Missing userId" });

      if (!localId || !zoneId || !location?.lat || !location?.lng) {
        return res.status(400).json({
          error: "Missing required fields: localId, zoneId, location.lat, location.lng",
        });
      }

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Items must be a non-empty array" });
      }

      const itemsObj: Record<string, any> = {};
      items.forEach((it: any, idx: number) => {
        const key = `i${idx + 1}`;
        itemsObj[key] = {
          productId: String(it?.productId || ""),
          productName: String(it?.productName || ""),
          quantity: Number(it?.quantity || 0),
          unitPrice: Number(it?.unitPrice || 0),
          totalPrice: 0,
          comments: String(it?.comments || ""),
          image: String(it?.image || ""),
        };
      });

      for (const [k, it] of Object.entries(itemsObj) as any) {
        if (!it.productId || !it.productName || Number(it.quantity) <= 0 || Number(it.unitPrice) < 0) {
          return res.status(400).json({ error: `Invalid item at ${k}` });
        }
      }

      const totals = calcTotals(itemsObj, Number(deliveryFee || 0), Number(discount || 0));

      const orderRef = rtdb.ref("ordersDelivery").push();
      const orderId = orderRef.key as string;
      if (!orderId) throw new Error("orderId is null");

      const createdAt = nowTs();

      const orderData: Record<string, any> = {
        id: orderId,
        type: "delivery",
        userId: String(userId),
        localId: String(localId),
        deliveryManId: null,
        status: "created",
        createdAt,
        updatedAt: nowTs(),

        payment: {
          method: String(payment?.method || "cash"),
          status: "pending",
        },

        totals,
        items: itemsObj,

        location: {
          zoneId: String(zoneId),
          zoneName: String(zoneName || ""),
          lat: Number(location.lat),
          lng: Number(location.lng),
          addressText: String(location.addressText || ""),
          references: String(location.references || ""),
        },

        customerSnapshot: {
          name: String(customerSnapshot?.name || ""),
          phone: String(customerSnapshot?.phone || ""),
        },

        localSnapshot: {
          name: String(localSnapshot?.name || ""),
          phone: String(localSnapshot?.phone || ""),
          logoUrl: String(localSnapshot?.logoUrl || ""),
        },
      };

      const historyRef = rtdb.ref(`ordersDelivery/${orderId}/history`).push();
      const historyId = historyRef.key as string;
      if (!historyId) throw new Error("historyId is null");

      // historyEntry
      const historyEntry = { status: "created", at: nowTs(), by: "user" };

      // mete history dentro del orderData (NO path hijo en updates)
      orderData.history = {
        [historyId]: historyEntry,
      };

      const updates: Record<string, any> = {};
      updates[`ordersDelivery/${orderId}`] = orderData;

      // SOLO índices fuera de ordersDelivery/*
      updates[`ordersDeliveryByUser/${String(userId)}/${orderId}`] = true;
      updates[`ordersDeliveryByLocal/${String(localId)}/${orderId}`] = true;
      updates[`ordersDeliveryByStatus/created/${orderId}`] = true;

      await rtdb.ref().update(updates);

      logger.info("Order created", { orderId, userId, localId });
      return res.status(200).json({ ok: true, orderId });

    } catch (e: any) {
      logger.error("createOrderDelivery error", e);
      return res.status(500).json({ error: e?.message || "Internal error" });
    }
  });
});


/**
 * POST /cancelOrderDelivery
 */
export const cancelOrderDelivery = onRequest(async (req: any, res: any) => {
  corsHandler(req, res, async () => {
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const { userId, orderId, reason } = (req.body || {}) as Record<string, any>;
      if (!userId || !orderId) return res.status(400).json({ error: "Missing userId or orderId" });

      const orderSnap = await rtdb.ref(`ordersDelivery/${String(orderId)}`).get();
      if (!orderSnap.exists()) return res.status(404).json({ error: "Order not found" });

      const order = orderSnap.val() as any;
      if (String(order.userId) !== String(userId)) return res.status(403).json({ error: "Forbidden" });

      const currentStatus = String(order.status || "created");
      if (!isCancellable(currentStatus)) {
        return res.status(400).json({ error: `Order cannot be cancelled from status: ${currentStatus}` });
      }

      const ts = nowTs();

      const historyRef = rtdb.ref(`ordersDelivery/${String(orderId)}/history`).push();
      const historyId = historyRef.key as string;
      if (!historyId) throw new Error("historyId is null");

      const updates: Record<string, any> = {};
      updates[`ordersDelivery/${String(orderId)}/status`] = "cancelled";
      updates[`ordersDelivery/${String(orderId)}/updatedAt`] = ts;
      updates[`ordersDelivery/${String(orderId)}/cancelReason`] = String(reason || "");
      updates[`ordersDelivery/${String(orderId)}/cancelledAt`] = ts;
      updates[`ordersDelivery/${String(orderId)}/history/${historyId}`] = {
        status: "cancelled",
        at: ts,
        by: "user",
        reason: String(reason || ""),
      };

      updates[`ordersDeliveryByStatus/${currentStatus}/${String(orderId)}`] = null;
      updates[`ordersDeliveryByStatus/cancelled/${String(orderId)}`] = true;

      await rtdb.ref().update(updates);

      logger.info("Order cancelled", { orderId, userId });

      return res.status(200).json({ ok: true });
    } catch (e: any) {
      logger.error("cancelOrderDelivery error", e);
      return res.status(500).json({ error: e?.message || "Internal error" });
    }
  });
});

