/** The manual jobs a seller can time, matching the agent's write tools one for one. */
export const BASELINE_TASKS: Array<{ task: string; label: string; how: string }> = [
  { task: "update_order_status", label: "Change an order's status", how: "Open Orders, find the order, change its status (add tracking if shipping)." },
  { task: "send_customer_message", label: "Message a customer", how: "Find the order, open its chat, type and send the update." },
  { task: "adjust_stock", label: "Adjust stock", how: "Open Products, find the item, edit its stock and save." },
  { task: "cancel_order", label: "Cancel an order", how: "Find the order, check it has not shipped, cancel it." },
  { task: "create_return", label: "Start a return", how: "Find the order, check the return window, record the return and tell the customer." },
  { task: "make_offer", label: "Offer a special price", how: "Find the order, open its chat, send a price offer with a note." },
  { task: "notify_delayed_customers", label: "Tell all delayed customers", how: "Find every order not dispatched in 24 h, open each chat and send a delay update." },
  { task: "create_purchase_order", label: "Restock from a supplier", how: "Check how fast it sells, work out a quantity, message the supplier and agree the order." },
  { task: "reroute_shipment", label: "Re-book a stuck parcel", how: "Check tracking, call the courier, book another courier and send the buyer the new tracking number." },
  { task: "issue_refund", label: "Issue a refund", how: "Find the order and payment, issue the refund and tell the customer." },
];

export const taskLabel = (task: string) => BASELINE_TASKS.find((t) => t.task === task)?.label ?? task;
