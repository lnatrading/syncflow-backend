// ============================================================
//  SyncFlow — orderClients/TDBalticClient.js
//  TD Baltic XML API — order placement & status tracking
//  Docs: Automated Order Processing via XML, Revision 2.1
//
//  ORDSND: POST to ixml.ORDSND with XML in body (UTF-8)
//  ORDRSP: GET ixml.ordrsp?origdocref= for order status
//  Auth:   orgnum, username, pwd as POST/GET params
// ============================================================
const axios  = require('axios');
const { XMLParser } = require('fast-xml-parser');

const BASE    = 'https://tdonline.tdbaltic.net/pls/PROD';
const ORGNUM  = '276054';
const USERNAME = 'ABAYOUMI-XML';
const PWD     = 'CT04ct09ct1984*';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['Order','Line','Parcel','Serial'].includes(name),
});

// ── PLACE ORDER ───────────────────────────────────────────────
// Sends XML purchase order via ORDSND endpoint
// TD Baltic uses HTTP POST with form params including xmlmsg
async function placeOrder(order) {
  // Build XML order per ORDSND spec (Rev 2.1)
  const linesXml = (order.lines || []).map(l => `
    <Line>
      <ItemID>${escXml(l.sku)}</ItemID>
      <OrigLineRef>${escXml(l.odoo_line_ref || l.sku)}</OrigLineRef>
      <Qty>${parseInt(l.quantity) || 1}</Qty>
    </Line>`).join('');

  const addr = order.shipping_address || {};
  const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<OrderEnv>
  <Order>
    <Head>
      <OrigDocRef>${escXml(order.odoo_sale_ref)}</OrigDocRef>
      <DeliverTo>
        <Address>
          <Name>${escXml(addr.name || '')}</Name>
          <Street>${escXml(addr.street || '')}</Street>
          <City>${escXml(addr.city || '')}</City>
          <ZIP>${escXml(addr.zip || '')}</ZIP>
          <CountryCode>${escXml(addr.country || 'PL')}</CountryCode>
          <ReceiverName>${escXml(addr.name || '')}</ReceiverName>
          <ReceiverMobileNumber>${escXml(addr.phone || '')}</ReceiverMobileNumber>
          <ReceiverEmailAddress>${escXml(addr.email || '')}</ReceiverEmailAddress>
        </Address>
      </DeliverTo>
    </Head>
    <Body>
      ${linesXml}
    </Body>
  </Order>
</OrderEnv>`;

  // POST as form params — credentials + xmlmsg
  const params = new URLSearchParams({
    orgnum:   ORGNUM,
    username: USERNAME,
    pwd:      PWD,
    xmlmsg:   xmlPayload,
  });

  const res = await axios.post(
    `${BASE}/ixml.ORDSND`,
    params.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
    }
  );

  // Parse response — success: <Msg ID="0" OrigDocRef="?">Booked order 123456</Msg>
  const parsed = parser.parse(res.data);
  const msgEl  = parsed?.Msgs?.Msg || parsed?.Msg || {};
  const msgId  = msgEl['@_ID'] || msgEl.ID || '';
  const msgText = typeof msgEl === 'string' ? msgEl : (msgEl['#text'] || msgEl._ || '');
  const origRef = msgEl['@_OrigDocRef'] || msgEl.OrigDocRef || order.odoo_sale_ref;

  if (String(msgId) !== '0') {
    throw new Error(`TD Baltic order rejected (ID ${msgId}): ${msgText}`);
  }

  // Extract TD Baltic order number from message text "Booked order 123456"
  const orderNumMatch = String(msgText).match(/\d+/);
  const supplierOrderRef = orderNumMatch ? orderNumMatch[0] : origRef;

  return {
    supplierOrderRef: String(supplierOrderRef),
    supplierOrderId:  String(supplierOrderRef),
    raw:              { msgId, msgText, origRef },
  };
}

// ── GET TRACKING ───────────────────────────────────────────────
// Uses ORDRSP to get order status and parcel numbers
// Parcel numbers from <ParcelList> can be used as tracking numbers
async function getTracking(supplierOrderRef) {
  const res = await axios.get(
    `${BASE}/ixml.ordrsp`,
    {
      params: {
        orgnum:      ORGNUM,
        username:    USERNAME,
        pwd:         PWD,
        origdocref:  supplierOrderRef,
      },
      timeout: 15000,
    }
  );

  const parsed = parser.parse(res.data);
  const orders = parsed?.OrderList?.Order || [];
  const order  = Array.isArray(orders) ? orders[0] : orders;

  if (!order) return { status: 'placed', tracking_number: null };

  const head       = order.Head || {};
  const orderStatus = head.OrderStatus || '';
  const lines      = order.Body?.Line || [];
  const lineArr    = Array.isArray(lines) ? lines : [lines];

  // Get parcel tracking numbers — TD Baltic puts them in INVOIC but
  // ORDRSP gives us line statuses which we can use to determine status
  const lineStatuses = lineArr.map(l => String(l.LineStatus || '').toUpperCase());
  const allShipped  = lineStatuses.length > 0 && lineStatuses.every(s => s === 'CLOSED');
  const anyShipping = lineStatuses.some(s => s === 'AWAITING_SHIPPING');
  const allCancelled = lineStatuses.every(s => s === 'CANCELLED');

  // Try to get tracking from invoice endpoint
  let trackingNumber = null;
  let trackingUrl    = null;
  try {
    const invRes = await axios.get(
      `${BASE}/ixml.invoic`,
      {
        params: { orgnum: ORGNUM, username: USERNAME, pwd: PWD, origdocref: supplierOrderRef },
        timeout: 10000,
      }
    );
    const invParsed = parser.parse(invRes.data);
    const invoices  = invParsed?.InvoiceList?.Invoice || [];
    const inv       = Array.isArray(invoices) ? invoices[0] : invoices;
    if (inv) {
      const invLines = inv.Body?.Line || [];
      const invLine  = Array.isArray(invLines) ? invLines[0] : invLines;
      if (invLine?.Waybill) trackingNumber = String(invLine.Waybill);
      // ParcelList for tracking
      const parcels = invLine?.ParcelList?.Parcel || [];
      const parcelArr = Array.isArray(parcels) ? parcels : [parcels];
      if (parcelArr.length) trackingNumber = trackingNumber || String(parcelArr[0]);
    }
  } catch(e) {
    // Invoice not yet available — normal for recently placed orders
  }

  return {
    status:          mapTDStatus(orderStatus, allShipped, anyShipping, allCancelled),
    tracking_number: trackingNumber,
    tracking_url:    trackingUrl,
    carrier:         'TD Baltic',
    raw:             { orderStatus, lineStatuses },
  };
}

function mapTDStatus(headerStatus, allShipped, anyShipping, allCancelled) {
  const s = String(headerStatus || '').toUpperCase();
  if (s === 'CANCELLED' || allCancelled)      return 'cancelled';
  if (s === 'CLOSED' || allShipped)           return 'shipped';
  if (s === 'BOOKED' && anyShipping)          return 'placed';
  if (s === 'BOOKED')                         return 'placed';
  if (s === 'ENTERED')                        return 'placing';
  return 'placed';
}

function escXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { placeOrder, getTracking };
