import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import cors from "cors";

import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

initializeApp();

const db = getFirestore();
const corsHandler = cors({ origin: true });

function calcTotalsFromItemTotals(items: any[]) {
  let subtotal = 0;
  for (const it of items) subtotal += Number(it?.totalPrice || 0);
  const total = Math.max(0, subtotal);
  return { subtotal, deliveryFee: 0, discount: 0, total, currency: "MXN" };
}

function pickProductFields(it: any) {
  const info = it?.infoProduct || {};
  return {
    productId: String(it?.productID ?? ""),
    quantity: Number(it?.quantity ?? 0),
    unitPrice: Number(info?.precio ?? info?.acf?.price ?? 0),
    totalPrice: Number(it?.total ?? 0),
    slug: String(info?.slug ?? ""),
    image: String(info?.imagen ?? ""),
    comments: String(it?.comments ?? ""),
  };
}

/**
 * POST /createOrderDelivery
 */
export const createOrderDelivery = onRequest(async (req: any, res: any) => {
  corsHandler(req, res, async () => {
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

      const body = (req.body || {}) as Record<string, any>;
      const userId = String(body.userId || "");
      const orders = body.orders ?? body.data ?? body.payload ?? body;

      if (!userId) return res.status(400).json({ error: "Missing userId" });
      if (!Array.isArray(orders) || orders.length === 0) {
        return res.status(400).json({ error: "Missing orders: must be a non-empty array" });
      }

      const createdOrderIds: string[] = [];
      const batch = db.batch();

      for (let o = 0; o < orders.length; o++) {
        const ord = orders[o];

        const localId = String(ord?.bussineId ?? "");
        const localName = String(ord?.bussineName ?? "");
        const zoneId = String(ord?.bussineZoneId ?? "");
        const zoneName = String(ord?.bussineZoneName ?? "");
        const deliveryMethod = String(ord?.deliveryMethod ?? "pickup");

        const lat = Number(ord?.bussineLocation?.lat);
        const lng = Number(ord?.bussineLocation?.long);

        if (!localId || !zoneId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          return res.status(400).json({
            error: `Invalid order at index ${o}: requires bussineId, bussineZoneId, bussineLocation.lat, bussineLocation.long`,
          });
        }

        if (!Array.isArray(ord?.items) || ord.items.length === 0) {
          return res.status(400).json({ error: `Invalid order at index ${o}: items must be a non-empty array` });
        }

        const items = ord.items.map((it: any) => pickProductFields(it));

        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (!it.productId || Number(it.quantity) <= 0) {
            return res.status(400).json({
              error: `Invalid item at order[${o}].items[${i}]: missing productID or quantity`,
            });
          }
          if (Number(it.totalPrice) < 0) {
            return res.status(400).json({
              error: `Invalid item at order[${o}].items[${i}]: total < 0`,
            });
          }
        }

        const totals = calcTotalsFromItemTotals(items);

        const orderRef = db.collection("ordersDelivery").doc();
        const orderId = orderRef.id;
        createdOrderIds.push(orderId);

        const ts = FieldValue.serverTimestamp();

        batch.set(orderRef, {
          id: orderId,
          type: deliveryMethod === "pickup" ? "pickup" : "delivery",
          userId,
          localId,
          deliveryManId: null,
          status: "created",
          createdAt: ts,
          updatedAt: ts,
          payment: { method: "cash", status: "pending" },
          totals,
          items,
          location: { zoneId, zoneName, lat, lng },
          localSnapshot: { name: localName },
        });

        batch.set(orderRef.collection("history").doc(), {
          status: "created",
          at: ts,
          by: "user",
        });
      }

      await batch.commit();

      logger.info("Orders created", { userId, count: createdOrderIds.length });
      return res.status(200).json({ ok: true, orderIds: createdOrderIds });
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

      const orderRef = db.collection("ordersDelivery").doc(String(orderId));
      const snap = await orderRef.get();
      if (!snap.exists) return res.status(404).json({ error: "Order not found" });

      const order = snap.data() as any;
      if (String(order.userId) !== String(userId)) return res.status(403).json({ error: "Forbidden" });

      const currentStatus = String(order.status || "created");
      if (!["created", "confirmed"].includes(currentStatus)) {
        return res.status(400).json({ error: `Order cannot be cancelled from status: ${currentStatus}` });
      }

      const ts = FieldValue.serverTimestamp();
      const batch = db.batch();

      batch.update(orderRef, {
        status: "cancelled",
        updatedAt: ts,
        cancelReason: String(reason || ""),
        cancelledAt: ts,
      });

      batch.set(orderRef.collection("history").doc(), {
        status: "cancelled",
        at: ts,
        by: "user",
        reason: String(reason || ""),
      });

      await batch.commit();

      logger.info("Order cancelled", { orderId, userId });
      return res.status(200).json({ ok: true });
    } catch (e: any) {
      logger.error("cancelOrderDelivery error", e);
      return res.status(500).json({ error: e?.message || "Internal error" });
    }
  });
});
