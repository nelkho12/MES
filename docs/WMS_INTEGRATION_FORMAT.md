# MayraLab / Kettler MES — WMS Integration & File Format Specification (`mayralab-wms-v1`)

The MES works **100% without a WMS server inside the applet**. Operators and Admins can exchange **Raw Material Stock** and **Finished Goods Lots** using standardized JSON or CSV files, or enable the optional browser-side **WMS REST Connector** in **Admin Settings** (switched **OFF** by default).

---

## 1. JSON File Formats (`schemaVersion: "mayralab-wms-v1"`)

### 1A. Raw Material Stock (`raw_material_stock`)
```json
{
  "schemaVersion": "mayralab-wms-v1",
  "exportedAt": "2026-11-20T08:00:00.000Z",
  "recordType": "raw_material_stock",
  "items": [
    {
      "lotNumber": "RM-SOY-261120-A",
      "materialCode": "ING-SOY-05",
      "materialName": "Organic Tamari Soy Base",
      "category": "Ingredient",
      "unit": "L",
      "quantityInitial": 1000,
      "quantityAvailable": 850,
      "quantityAllocated": 145,
      "reorderLevel": 200,
      "unitCost": 3.45,
      "supplier": "Kyoto Ferments",
      "expiryDate": "2027-08-31",
      "storageZone": "Ambient Rack A2",
      "status": "Available"
    }
  ]
}
```
* **Upsert Key**: `lotNumber` (case-insensitive).
* **Required Fields**: `lotNumber`, `materialCode`, `materialName`, `quantityAvailable` ($\ge 0$).
* **Allowed Units**: `kg`, `g`, `L`, `ml`, `pcs`.
* **Allowed Categories**: `Ingredient`, `Packaging`.

### 1B. Finished Goods Lots (`finished_goods_lots`)
```json
{
  "schemaVersion": "mayralab-wms-v1",
  "exportedAt": "2026-11-20T08:05:00.000Z",
  "recordType": "finished_goods_lots",
  "items": [
    {
      "lotNumber": "LOT-261120-L1-TERI-001",
      "batchNumber": "B-261120-001",
      "sku": "SKU-TERI-250",
      "productName": "Artisan Teriyaki Glaze",
      "quantityProduced": 1200,
      "quantityAvailable": 1150,
      "unit": "bottles",
      "productionDate": "2026-11-20",
      "expiryDate": "2027-05-19",
      "qcStatus": "Released",
      "warehouseZone": "FG Ambient Aisle 1",
      "unitCost": 1.84
    }
  ]
}
```
* **Upsert Key**: `lotNumber` (case-insensitive).
* **Updates on Existing FG Lots**: `quantityAvailable`, `warehouseZone`, `qcStatus` (`Released` | `Quarantined`), `expiryDate`.

---

## 2. CSV File Formats

### 2A. Raw Material Stock CSV Header
```csv
lotNumber,materialCode,materialName,category,unit,quantityInitial,quantityAvailable,quantityAllocated,reorderLevel,unitCost,supplier,expiryDate,storageZone,status
RM-SOY-261120-A,ING-SOY-05,Organic Tamari Soy Base,Ingredient,L,1000,850,145,200,3.45,Kyoto Ferments,2027-08-31,Ambient Rack A2,Available
```

### 2B. Finished Goods Lots CSV Header
```csv
lotNumber,batchNumber,sku,productName,quantityProduced,quantityAvailable,unit,productionDate,expiryDate,qcStatus,warehouseZone,unitCost
LOT-261120-L1-TERI-001,B-261120-001,SKU-TERI-250,Artisan Teriyaki Glaze,1200,1150,bottles,2026-11-20,2027-05-19,Released,FG Ambient Aisle 1,1.84
```

---

## 3. Optional External WMS REST Connector Contract (OFF by Default)

Configure the base URL and paths under **Admin Settings → Optional WMS REST Connector**:
* **GET `{baseUrl}{rawMaterialsPath}`** (default `/raw-materials`):
  Returns HTTP `200` with `{ "schemaVersion": "mayralab-wms-v1", "items": [ ... ] }` (or a bare JSON array).
* **GET `{baseUrl}{finishedGoodsPath}`** (default `/finished-goods`):
  Returns HTTP `200` with `{ "schemaVersion": "mayralab-wms-v1", "items": [ ... ] }`.
* **POST `{baseUrl}{finishedGoodsPath}`**:
  Accepts `{ "schemaVersion": "mayralab-wms-v1", "exportedAt": "...", "recordType": "finished_goods_lots", "items": [ ... ] }` and returns HTTP `200`/`201`.
* **CORS Requirement**: Because the browser applet invokes the external WMS URL directly without an intermediate WMS server inside the applet, the external WMS must return `Access-Control-Allow-Origin` and allow `GET, POST, OPTIONS` with `Content-Type: application/json`.
