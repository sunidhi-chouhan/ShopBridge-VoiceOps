/**
 * External partners behind narrow interfaces. The prototype ships simulated connectors with
 * deterministic, clearly-labelled behaviour; a real courier aggregator (for example Shiprocket) or a
 * supplier's ordering channel plugs in by implementing the same interface. Connectors are only ever
 * called from orchestrator `execute`, i.e. after a human approval.
 */
import { createHash } from "node:crypto";

export type PurchaseOrderRequest = {
  poId: string;
  supplier: { id: string; name: string; lead_time_days: number };
  product: string;
  quantity: number;
  unitCost: number;
};
export type PurchaseOrderReceipt = { supplierRef: string; state: "confirmed" | "sent"; eta: string; simulated: boolean; note: string };

export interface SupplierConnector {
  readonly name: string;
  sendPurchaseOrder(request: PurchaseOrderRequest, now?: number): Promise<PurchaseOrderReceipt>;
}

export type CourierQuote = { courier: string; service: string; eta_days: number; cost_inr: number };
export type Rebooking = { courier: string; awb: string; eta: string; simulated: boolean };

export interface CourierConnector {
  readonly name: string;
  /** Alternatives for a parcel that must be re-booked, cheapest-fastest first. */
  quotes(input: { fromCity: string; currentCourier: string }): Promise<CourierQuote[]>;
  rebook(input: { orderId: string; courier: string; quote: CourierQuote }, now?: number): Promise<Rebooking>;
}

const DAY = 86_400_000;
const digits = (seed: string, n: number) => {
  const hex = createHash("sha256").update(seed).digest("hex");
  return (BigInt(`0x${hex.slice(0, 15)}`) % BigInt(10 ** n)).toString().padStart(n, "0");
};

/** Confirms every order at once with the supplier's lead time. Marked simulated in every receipt. */
export const simulatedSupplier: SupplierConnector = {
  name: "simulated",
  async sendPurchaseOrder(request, now = Date.now()) {
    return {
      supplierRef: `SIM-PO-${digits(request.poId, 6)}`,
      state: "confirmed",
      eta: new Date(now + request.supplier.lead_time_days * DAY).toISOString(),
      simulated: true,
      note: `${request.supplier.name} confirmed ${request.quantity} × ${request.product} (simulated supplier).`,
    };
  },
};

const COURIERS: CourierQuote[] = [
  { courier: "Blue Dart", service: "Express", eta_days: 2, cost_inr: 95 },
  { courier: "Xpressbees", service: "Surface", eta_days: 3, cost_inr: 62 },
  { courier: "Delhivery", service: "Surface", eta_days: 4, cost_inr: 58 },
  { courier: "Ekart", service: "Standard", eta_days: 4, cost_inr: 55 },
];

/** Fixed rate card; rebooking returns a new tracking number. Never the courier the parcel is stuck with. */
export const simulatedCourier: CourierConnector = {
  name: "simulated",
  async quotes({ currentCourier }) {
    return COURIERS.filter((q) => q.courier.toLowerCase() !== currentCourier.toLowerCase())
      .sort((a, b) => a.eta_days - b.eta_days || a.cost_inr - b.cost_inr);
  },
  async rebook({ orderId, courier, quote }, now = Date.now()) {
    const prefix = courier.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
    return { courier, awb: `${prefix}${digits(`${orderId}|${courier}|${now}`, 8)}`, eta: new Date(now + quote.eta_days * DAY).toISOString(), simulated: true };
  },
};

export function supplierConnector(_name = process.env.SUPPLIER_CONNECTOR || "simulated"): SupplierConnector {
  return simulatedSupplier;
}

export function courierConnector(_name = process.env.COURIER_CONNECTOR || "simulated"): CourierConnector {
  return simulatedCourier;
}
