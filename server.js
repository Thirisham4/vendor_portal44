require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(cors());

const SAP_USERNAME = process.env.SAP_USERNAME;
const SAP_PASSWORD = process.env.SAP_PASSWORD;
const SAP_BASE_URL = process.env.SAP_BASE_URL;

const agent = new https.Agent({ rejectUnauthorized: false });

function parseSapDate(sapDate) {
  // Format: /Date(1721865600000)/ → Extract timestamp
  const match = sapDate?.match(/\/Date\((\d+)\)\//);
  if (match) {
    return new Date(Number(match[1])).toISOString().split('T')[0];
  }

  // Format: 20250520 → Convert to YYYY-MM-DD
  if (sapDate?.length === 8) {
    const yyyy = sapDate.substring(0, 4);
    const mm = sapDate.substring(4, 6);
    const dd = sapDate.substring(6, 8);
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}


// 🔐 Login
app.post('/login', async (req, res) => {
  const { lifnr, password } = req.body;
  if (!lifnr || !password) return res.status(400).json({ error: 'Lifnr and password are required' });

  const url = `${SAP_BASE_URL}/ZVENDOR_THILOGINSet(Lifnr='${lifnr}')`;

  try {
    const response = await axios.get(url, {
      httpsAgent: agent,
      auth: { username: SAP_USERNAME, password: SAP_PASSWORD },
      headers: { 'Accept': 'application/json' }
    });

    const sapData = response.data?.d;
    if (!sapData) return res.status(404).json({ message: 'Vendor not found' });

    if (sapData.Password === password) {
      return res.status(200).json({ message: 'Login successful' });
    } else {
      return res.status(401).json({ message: 'Invalid password' });
    }

  } catch (error) {
    return handleSapError(res, error, 'SAP Login Error');
  }
});

// Profile
app.get('/profile/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId?.padStart(10, '0');
  const url = `${SAP_BASE_URL}/ZTHI_VENDORPROFILESet(VendorId='${vendorId}')`;

  try {
    const response = await axios.get(url, {
      httpsAgent: agent,
      auth: { username: SAP_USERNAME, password: SAP_PASSWORD },
      headers: { 'Accept': 'application/json' }
    });

    const data = response.data?.d;
    if (!data) return res.status(404).json({ message: 'Profile not found' });

    const profile = {
      vendorId: data.VendorId,
      name: data.Name,
      city: data.City,
      country: data.Country,
      postcode: data.Postcode,
      street: data.Street
    };

    return res.status(200).json(profile);

  } catch (error) {
    return handleSapError(res, error, 'SAP Profile Error');
  }
});

// Goods Receipt
app.get('/goodsreceipt/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId?.padStart(10, '0');
  const url = `${SAP_BASE_URL}/ZTHI_GOODSSet?$filter=(VendorId eq '${vendorId}')`;

  try {
    const response = await axios.get(url, {
      httpsAgent: agent,
      auth: { username: SAP_USERNAME, password: SAP_PASSWORD },
      headers: { 'Accept': 'application/json' }
    });

    const entries = response.data?.d?.results || [];
    if (entries.length === 0) return res.status(404).json({ message: 'No goods receipts found' });

    const goodsReceipts = entries.map(entry => ({
      materialDoc: entry.MaterialDoc,
      docYear: entry.DocYear,
      postDate: parseSapDate(entry.PostDate),
      entryDate: parseSapDate(entry.EntryDate),
      poNumber: entry.PoNumber,
      poItem: entry.PoItem,
      material: entry.Material,
      quantity: entry.Quantity,
      unit: entry.Unit,
      vendorId: entry.VendorId
    }));

    res.json(goodsReceipts);

  } catch (error) {
    return handleSapError(res, error, 'SAP Goods Receipt Error');
  }
});

// Invoices
app.get('/invoices/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId?.padStart(10, '0');
  const url = `${SAP_BASE_URL}/ZTHI_INVOICETABLESet?$filter=(VendorId eq '${vendorId}')`;

  try {
    const response = await axios.get(url, {
      httpsAgent: agent,
      auth: { username: SAP_USERNAME, password: SAP_PASSWORD },
      headers: { 'Accept': 'application/json' }
    });

    const entries = response.data?.d?.results || [];
    if (entries.length === 0) return res.status(404).json({ message: 'No invoices found' });

    const invoices = entries.map(entry => ({
      invoiceNo: entry.InvoiceNo,
      invoiceDate: parseSapDate(entry.InvoiceDate),
      totalAmount: entry.TotalAmount,
      currency: entry.Currency,
      paymentTerms: entry.PaymentTerms,
      poNo: entry.PoNo,
      poItem: entry.PoItem,
      materialNo: entry.MaterialNo,
      description: entry.Description,
      quantity: entry.Quantity,
      unitPrice: entry.UnitPrice,
      unit: entry.Unit
    }));

    res.json(invoices);

  } catch (error) {
    return handleSapError(res, error, 'SAP Invoice Error');
  }
});

// 🔽 PDF Invoice Download using Adobe Form
app.get('/invoice/:invoiceId', async (req, res) => {
  const invoiceId = req.params.invoiceId;
  const url = `${SAP_BASE_URL}/ZTHI_OINVSet('${invoiceId}')/$value`;

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      httpsAgent: agent,
      auth: {
        username: SAP_USERNAME,
        password: SAP_PASSWORD
      },
      headers: {
        'Accept': 'application/pdf'
      }
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=Invoice_${invoiceId}.pdf`,
      'Content-Length': response.data.length
    });

    res.send(response.data);
  } catch (error) {
    console.error('❌ Error fetching invoice PDF:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    res.status(500).json({ success: false, message: 'Failed to download invoice PDF' });
  }
});


// Memos
app.get('/memos/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId?.padStart(10, '0');
  const url = `${SAP_BASE_URL}/ZTHI_MEMOSet?$filter=(VendorId eq '${vendorId}')`;

  try {
    const response = await axios.get(url, {
      httpsAgent: agent,
      auth: { username: SAP_USERNAME, password: SAP_PASSWORD },
      headers: { 'Accept': 'application/json' }
    });

    const entries = response.data?.d?.results || [];

    const memos = entries.map(entry => ({
      memoDoc: entry.MemoDoc,
      docYear: entry.DocYear,
      postingDate: parseSapDate(entry.PostingDate),
      entryDate: parseSapDate(entry.EntryDate),
      vendorId: entry.VendorId,
      memoType: entry.MemoType,
      amount: entry.Amount,
      currency: entry.Currency,
      referenceDocNo: entry.ReferenceDocNo,
      docType: entry.DocType,
      companyCode: entry.CompanyCode
    }));

    res.json(memos);

  } catch (error) {
    return handleSapError(res, error, 'SAP Memo Error');
  }
});

// Purchase Orders
app.get('/purchase-orders/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId?.padStart(10, '0');
  const url = `${SAP_BASE_URL}/ZTHI_PURCHASESet?$filter=(VendorId eq '${vendorId}')`;

  try {
    const response = await axios.get(url, {
      httpsAgent: agent,
      auth: { username: SAP_USERNAME, password: SAP_PASSWORD },
      headers: { 'Accept': 'application/json' }
    });

    const entries = response.data?.d?.results || [];

    const purchaseOrders = entries.map(entry => ({
      vendorId: entry.VendorId,
      deliveryDate: parseSapDate(entry.DeliveryDate),
      docDate: parseSapDate(entry.DocDate),
      material: entry.Material,
      unit: entry.Unit,
      poNumber: entry.PoNumber,
      itemNumber: entry.ItemNumber
    }));

    res.json(purchaseOrders);

  } catch (error) {
    return handleSapError(res, error, 'SAP Purchase Order Error');
  }
});

app.get('/rfq/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId?.padStart(10, '0');
  const url = `${SAP_BASE_URL}/ZTHI_RFQSet?$filter=(Lifnr eq '${vendorId}')`;

  try {
    const response = await axios.get(url, {
      httpsAgent: agent,
      auth: { username: SAP_USERNAME, password: SAP_PASSWORD },
      headers: { 'Accept': 'application/json' }
    });

    const entries = response.data?.d?.results || [];

    const rfqs = entries.map(entry => {
      console.log("🔎 RFQ Entry:", entry); // ✅ Check Zbedat & Zeildt

      return {
        rfqNumber: entry.Ebeln,
        vendorId: entry.Lifnr,
        createdDate: parseSapDate(entry.Zbedat),
        itemNumber: entry.Ebelp,
        material: entry.Matnr,
        unit: entry.Meins,
        description: entry.Txz01,
        targetDate: parseSapDate(entry.Zeildt)
      };
    });

    res.json(rfqs);

  } catch (error) {
    return handleSapError(res, error, 'SAP RFQ Error');
  }
});


// Aging
app.get('/aging/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId?.padStart(10, '0');
  const url = `${SAP_BASE_URL}/ZTHI_V_AGINGSet?$filter=(VendorId eq '${vendorId}')`;

  try {
    const response = await axios.get(url, {
      httpsAgent: agent,
      auth: { username: SAP_USERNAME, password: SAP_PASSWORD },
      headers: { 'Accept': 'application/json' }
    });

    const entries = response.data?.d?.results || [];

    const agingData = entries.map(entry => ({
      paymentDoc: entry.PaymentDoc,
      docYear: entry.DocYear,
      paymentDate: parseSapDate(entry.PaymentDate),
      entryDate: parseSapDate(entry.EntryDate),
      vendorId: entry.VendorId,
      amountPaid: entry.AmountPaid,
      currency: entry.Currency,
      dueDate: parseSapDate(entry.DueDate),
      aging: entry.Aging
    }));

    res.json(agingData);

  } catch (error) {
    return handleSapError(res, error, 'SAP Aging Error');
  }
});

// 🧾 PDF Invoice Download
app.get('/invoice/:invoiceId', async (req, res) => {
  const invoiceId = req.params.invoiceId;
  const url = `${SAP_BASE_URL}/ZTHI_OINVSet('${invoiceId}')/$value`;

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      httpsAgent: agent,
      auth: {
        username: SAP_USERNAME,
        password: SAP_PASSWORD
      },
      headers: {
        'Accept': 'application/pdf'
      }
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=Invoice_${invoiceId}.pdf`,
      'Content-Length': response.data.length
    });

    res.send(response.data);
  } catch (error) {
    console.error('Error fetching invoice PDF:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    res.status(500).json({ success: false, message: 'Failed to download invoice PDF' });
  }
});

// 🔁 Error Handler
function handleSapError(res, error, context) {
  console.error(context, error.message);
  if (error.response) {
    return res.status(error.response.status).json({
      error: `${context}`,
      statusText: error.response.statusText,
      details: error.response.data
    });
  } else {
    return res.status(500).json({ error: `${context} failed`, details: error.message });
  }
}

// ✅ Start Server
app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});


























