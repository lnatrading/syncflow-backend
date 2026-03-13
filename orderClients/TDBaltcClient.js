// ============================================================
//  SyncFlow — orderClients/TDBalticClient.js
//  TD Baltic XML API — order placement & status
//  Auth: query params (orgnum, username, pwd)
// ============================================================
const axios  = require('axios');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');

const BASE    = 'http://tdonline.tdbaltic.net/pls/PROD/ixml';
const AUTH_QS = 'orgnum=276054&username=ABAYOUMI-XML&pwd=CT04ct09ct1984*';
const parser  = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// ── PLACE ORDER ───────────────────────────────────────────────
// TD Baltic uses XML POST for order creation
async function placeOrder(order) {
  const xmlLines = order.lines.map(l => ({
    Line: {
      PartNumber: l.sku,
      Quantity:   l.quantity,
      UnitPrice:  l.unit_price || '',
    }
  }));

  const xmlPayload = builder.build({
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    Order: {
      '@_xmlns': 'http://www.tdbaltic.net/ixml',
      Header: {
        CustomerReference: order.odoo_sale_ref,
        ShipToName:        order.shipping_address?.name    || '',
        ShipToAddress1:    order.shipping_address?.street  || '',
        ShipToCity:        order.shipping_address?.city    || '',
        ShipToPostCode:    order.shipping_address?.zip     || '',
        ShipToCountry:     order.shipping_address?.country || 'PL',
        ShipToPhone:       order.shipping_address?.phone   || '',
        ShipToEmail:       order.shipping_address?.email   || '',
      },
      Lines: xmlLines,
    }
  });

  const res = await axios.post(
    `${BASE}.Order?${AUTH_QS}`,
    xmlPayload,
    {
      headers: { 'Content-Type': 'text/xml' },
      timeout: 15000,
    }
  );

  const parsed    = parser.parse(res.data);
  const orderResp = parsed?.OrderResponse || parsed?.Response || {};
  const orderNum  = orderResp.OrderNumber || orderResp.ConfirmationNumber || order.odoo_sale_ref;

  return {
    supplierOrderRef: String(orderNum),
    supplierOrderId:  String(orderNum),
    subtotal:         parseFloat(orderResp.Subtotal) || null,
    shipping:         parseFloat(orderResp.Freight)  || null,
    total:            parseFloat(orderResp.Total)    || null,
    raw:              orderResp,
  };
}

// ── GET TRACKING ───────────────────────────────────────────────
// GET /ixml.OrderStatus?orgnum=...&OrderNumber=...
async function getTracking(supplierOrderRef) {
  const res = await axios.get(
    `${BASE}.OrderStatus?${AUTH_QS}&OrderNumber=${supplierOrderRef}`,
    { timeout: 10000 }
  );

  const parsed = parser.parse(res.data);
  const status = parsed?.OrderStatusResponse || parsed?.OrderStatus || {};

  return {
    status:          mapTDStatus(status.Status || status.OrderStatus),
    tracking_number: status.TrackingNumber || status.Tracking || null,
    tracking_url:    status.TrackingURL    || null,
    carrier:         status.Carrier        || status.Transporter || null,
    raw:             status,
  };
}

function mapTDStatus(s) {
  if (!s) return 'placed';
  const v = String(s).toUpperCase();
  if (['SHIPPED', 'DISPATCHED', 'SENT'].includes(v)) return 'shipped';
  if (['DELIVERED', 'COMPLETE', 'COMPLETED'].includes(v)) return 'delivered';
  if (['CANCELLED', 'CANCELED'].includes(v)) return 'cancelled';
  if (['ERROR', 'FAILED', 'REJECTED'].includes(v)) return 'error';
  return 'placed';
}

module.exports = { placeOrder, getTracking };
