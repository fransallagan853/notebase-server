require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const initSqlJs = require("sql.js");
const { parse } = require("csv-parse/sync");

const app = express();

app.use(cors());
app.use(express.json());
app.use("/admin", express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 5000;

const uploadDir = path.join(__dirname, "uploads");
const updateDir = path.join(__dirname, "updates");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

if (!fs.existsSync(updateDir)) {
  fs.mkdirSync(updateDir);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const originalName = file.originalname.replace(/\s+/g, "_");
    cb(null, `${timestamp}_${originalName}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

app.get("/", (req, res) => {
  res.json({
    message: "noteBase server berjalan"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "noteBase server aktif",
    timestamp: new Date().toISOString()
  });
});

app.post("/api/admin/upload-csv", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "File CSV belum dikirim"
      });
    }

    return res.json({
      success: true,
      message: "File berhasil diupload",
      file: {
        originalName: req.file.originalname,
        savedName: req.file.filename,
        path: req.file.path,
        size: req.file.size
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Gagal upload file",
      error: error.message
    });
  }
});

app.post("/api/admin/generate-update", async (req, res) => {
  try {
    const body = req.body || {};

    const fileName = body.fileName || getLatestUploadedFile();
    const mode = body.mode || "auto";
    const manualLeasing = body.manualLeasing || "";
    const manualCabang = body.manualCabang || "";
    const periodeData = normalizePeriodeData(body.periodeData || "");
    const mapping = body.mapping || {};

    if (!periodeData) {
      return res.status(400).json({
        success: false,
        message: "Periode data wajib diisi, contoh: 08/26"
      });
    }

    if (!fileName) {
      return res.status(400).json({
        success: false,
        message: "Belum ada file CSV di folder uploads"
      });
    }

    const csvPath = path.join(uploadDir, fileName);

    if (!fs.existsSync(csvPath)) {
      return res.status(404).json({
        success: false,
        message: "File CSV tidak ditemukan",
        fileName
      });
    }

    const csvText = fs.readFileSync(csvPath, "utf8");
    const delimiter = detectDelimiter(csvText);

    const records = parse(csvText, {
      bom: true,
      columns: (headers) => headers.map(normalizeHeader),
      skip_empty_lines: true,
      delimiter
    });

    if (!records || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: "CSV kosong atau tidak valid"
      });
    }

    const SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file)
    });

    const masterPath = path.join(updateDir, "master.sqlite");
    const newVersion = Date.now();

    let db;

    if (fs.existsSync(masterPath)) {
      const masterData = fs.readFileSync(masterPath);
      db = new SQL.Database(masterData);
    } else {
      db = new SQL.Database();
    }

    ensureVehicleSchema(db);

    const insert = db.prepare(`
      INSERT OR REPLACE INTO kendaraan_update (
        nopol,
        nopolKey,
        groupNumber,
        namaKendaraan,
        tahun,
        warna,
        noRangka,
        noMesin,
        leasing,
        cabang,
        saldo,
        overdue,
        catatan,
        periodeData,
        searchKey,
        sourceType,
        status,
        updatedAt,
        dataVersion
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      );
    `);

    let success = 0;
    let failed = 0;

    db.run("BEGIN TRANSACTION;");

    for (const row of records) {
      const vehicle = mapRowToVehicle(row, {
        mode,
        mapping,
        manualLeasing,
        manualCabang,
        periodeData
      });

      if (!vehicle.nopol) {
        failed++;
        continue;
      }

      insert.run([
        vehicle.nopol,
        vehicle.nopolKey,
        vehicle.groupNumber,
        vehicle.namaKendaraan,
        vehicle.tahun,
        vehicle.warna,
        vehicle.noRangka,
        vehicle.noMesin,
        vehicle.leasing,
        vehicle.cabang,
        vehicle.saldo,
        vehicle.overdue,
        vehicle.catatan,
        vehicle.periodeData,
        vehicle.searchKey,
        vehicle.sourceType,
        vehicle.status,
        vehicle.updatedAt,
        newVersion
      ]);

      success++;
    }

    db.run("COMMIT;");
    insert.free();

    const totalResult = db.exec("SELECT COUNT(*) AS total FROM kendaraan_update");
    const totalMasterRows = totalResult?.[0]?.values?.[0]?.[0] || 0;

    const sqliteData = db.export();
    db.close();

    fs.writeFileSync(masterPath, Buffer.from(sqliteData));

    // FULL file: dipakai user baru / install ulang.
    const fullFile = writeSqliteGzip(sqliteData, `notebase_full_${newVersion}`);

    const metadata = {
      success: true,
      updateType: "full",
      versionCode: newVersion,
      sourceCsv: fileName,
      mode,
      manualLeasing,
      manualCabang,
      periodeData,
      csvRows: records.length,
      processedRows: success,
      failedRows: failed,
      totalRows: totalMasterRows,
      sqliteFile: fullFile.sqliteFileName,
      gzipFile: fullFile.gzipFileName,
      sqlitePath: fullFile.sqlitePath,
      gzipPath: fullFile.gzipPath,
      masterPath,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(updateDir, "latest.json"),
      JSON.stringify(metadata, null, 2)
    );

    return res.json({
      success: true,
      message: "FULL SQLite.gz berhasil dibuat. DELTA akan dibuat otomatis saat APK sync.",
      data: metadata
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Gagal generate SQLite.gz",
      error: error.message
    });
  }
});

app.get("/api/update/latest", async (req, res) => {
  try {
    const latestPath = path.join(updateDir, "latest.json");

    if (!fs.existsSync(latestPath)) {
      return res.status(404).json({
        success: false,
        message: "Belum ada update tersedia"
      });
    }

    const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
    const latestVersion = Number(latest.versionCode || 0);
    const rawLastVersion = Number(req.query.lastVersion || 0);
    const lastVersion = Number.isFinite(rawLastVersion) ? rawLastVersion : 0;

    if (lastVersion >= latestVersion) {
      return res.json({
        success: true,
        data: {
          ...latest,
          updateType: "none",
          totalRows: 0,
          gzipFile: "",
          sqliteFile: "",
          fromVersion: lastVersion,
          toVersion: latestVersion
        }
      });
    }

    // User baru / database kosong: kirim FULL data terbaru.
    if (lastVersion <= 0) {
      return res.json({
        success: true,
        data: {
          ...latest,
          updateType: "full",
          fromVersion: 0,
          toVersion: latestVersion
        }
      });
    }

    // User lama: buat DELTA semua data setelah versi terakhir user.
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file)
    });

    const deltaFile = generateDeltaUpdateFile(SQL, lastVersion, latestVersion);

    return res.json({
      success: true,
      data: {
        ...latest,
        updateType: "delta",
        versionCode: latestVersion,
        totalRows: deltaFile.totalRows,
        sqliteFile: deltaFile.sqliteFileName,
        gzipFile: deltaFile.gzipFileName,
        sqlitePath: deltaFile.sqlitePath,
        gzipPath: deltaFile.gzipPath,
        fromVersion: lastVersion,
        toVersion: latestVersion,
        createdAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Gagal ambil update terbaru",
      error: error.message
    });
  }
});

app.get("/api/update/download/:fileName", (req, res) => {
  const fileName = req.params.fileName;
  const filePath = path.join(updateDir, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "File update tidak ditemukan"
    });
  }

  return res.download(filePath);
});

function ensureVehicleSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS kendaraan_update (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nopol TEXT NOT NULL,
      nopolKey TEXT NOT NULL DEFAULT '',
      groupNumber TEXT,
      namaKendaraan TEXT,
      tahun TEXT,
      warna TEXT,
      noRangka TEXT,
      noMesin TEXT,
      leasing TEXT,
      cabang TEXT,
      saldo TEXT,
      overdue TEXT,
      catatan TEXT,
      periodeData TEXT NOT NULL DEFAULT '',
      searchKey TEXT,
      sourceType TEXT,
      status TEXT,
      updatedAt TEXT,
      dataVersion INTEGER DEFAULT 0
    );
  `);

  ensureColumn(db, "kendaraan_update", "nopolKey", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "kendaraan_update", "periodeData", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "kendaraan_update", "dataVersion", "INTEGER DEFAULT 0");

  backfillNopolKeys(db);
  dedupeByNopolKey(db);

  db.run("DROP INDEX IF EXISTS idx_unique_vehicle;");

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_vehicle_nopolKey
    ON kendaraan_update(nopolKey)
    WHERE nopolKey != '';
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_search_key
    ON kendaraan_update(searchKey);
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_group_number
    ON kendaraan_update(groupNumber);
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_data_version
    ON kendaraan_update(dataVersion);
  `);
}

function backfillNopolKeys(db) {
  const result = db.exec("SELECT id, nopol FROM kendaraan_update WHERE nopolKey IS NULL OR nopolKey = '';");
  const rows = result?.[0]?.values || [];

  for (const row of rows) {
    const id = row[0];
    const nopol = row[1] || "";
    const nopolKey = generateNopolKey(nopol);

    db.run("UPDATE kendaraan_update SET nopolKey = ? WHERE id = ?;", [nopolKey, id]);
  }
}

function dedupeByNopolKey(db) {
  const result = db.exec(`
    SELECT id, nopolKey, dataVersion
    FROM kendaraan_update
    WHERE nopolKey != ''
    ORDER BY nopolKey ASC, dataVersion DESC, id DESC;
  `);

  const rows = result?.[0]?.values || [];
  const seen = new Set();
  const deleteIds = [];

  for (const row of rows) {
    const id = row[0];
    const nopolKey = row[1] || "";

    if (seen.has(nopolKey)) {
      deleteIds.push(id);
    } else {
      seen.add(nopolKey);
    }
  }

  for (const id of deleteIds) {
    db.run("DELETE FROM kendaraan_update WHERE id = ?;", [id]);
  }
}

function ensureColumn(db, tableName, columnName, columnDefinition) {
  const result = db.exec(`PRAGMA table_info(${tableName});`);
  const columns = result?.[0]?.values?.map((row) => row[1]) || [];

  if (!columns.includes(columnName)) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
  }
}

function writeSqliteGzip(sqliteData, baseName) {
  const sqliteFileName = `${baseName}.sqlite`;
  const gzipFileName = `${sqliteFileName}.gz`;

  const sqlitePath = path.join(updateDir, sqliteFileName);
  const gzipPath = path.join(updateDir, gzipFileName);

  fs.writeFileSync(sqlitePath, Buffer.from(sqliteData));

  const gzipData = zlib.gzipSync(Buffer.from(sqliteData), {
    level: 9
  });

  fs.writeFileSync(gzipPath, gzipData);

  return {
    sqliteFileName,
    gzipFileName,
    sqlitePath,
    gzipPath
  };
}

function generateDeltaUpdateFile(SQL, lastVersion, latestVersion) {
  const masterPath = path.join(updateDir, "master.sqlite");

  if (!fs.existsSync(masterPath)) {
    throw new Error("Master database belum tersedia");
  }

  const masterData = fs.readFileSync(masterPath);
  const masterDb = new SQL.Database(masterData);

  ensureVehicleSchema(masterDb);

  const select = masterDb.prepare(`
    SELECT
      nopol,
      nopolKey,
      groupNumber,
      namaKendaraan,
      tahun,
      warna,
      noRangka,
      noMesin,
      leasing,
      cabang,
      saldo,
      overdue,
      catatan,
      periodeData,
      searchKey,
      sourceType,
      status,
      updatedAt,
      dataVersion
    FROM kendaraan_update
    WHERE dataVersion > ?
    ORDER BY dataVersion ASC, nopol ASC;
  `);

  select.bind([lastVersion]);

  const rows = [];

  while (select.step()) {
    rows.push(select.getAsObject());
  }

  select.free();
  masterDb.close();

  const deltaDb = new SQL.Database();
  ensureVehicleSchema(deltaDb);

  const insert = deltaDb.prepare(`
    INSERT OR REPLACE INTO kendaraan_update (
      nopol,
      nopolKey,
      groupNumber,
      namaKendaraan,
      tahun,
      warna,
      noRangka,
      noMesin,
      leasing,
      cabang,
      saldo,
      overdue,
      catatan,
      periodeData,
      searchKey,
      sourceType,
      status,
      updatedAt,
      dataVersion
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    );
  `);

  deltaDb.run("BEGIN TRANSACTION;");

  for (const row of rows) {
    insert.run([
      row.nopol || "",
      row.nopolKey || generateNopolKey(row.nopol || ""),
      row.groupNumber || "",
      row.namaKendaraan || "",
      row.tahun || "",
      row.warna || "",
      row.noRangka || "",
      row.noMesin || "",
      row.leasing || "",
      row.cabang || "",
      row.saldo || "",
      row.overdue || "",
      row.catatan || "",
      row.periodeData || "",
      row.searchKey || "",
      row.sourceType || "ADMIN",
      row.status || "approved",
      row.updatedAt || new Date().toISOString(),
      Number(row.dataVersion || latestVersion)
    ]);
  }

  deltaDb.run("COMMIT;");
  insert.free();

  const sqliteData = deltaDb.export();
  deltaDb.close();

  const file = writeSqliteGzip(
    sqliteData,
    `notebase_delta_${lastVersion}_to_${latestVersion}_${Date.now()}`
  );

  return {
    ...file,
    totalRows: rows.length
  };
}

function getLatestUploadedFile() {
  const files = fs
    .readdirSync(uploadDir)
    .filter((file) => file.toLowerCase().endsWith(".csv"))
    .map((file) => {
      const filePath = path.join(uploadDir, file);
      return {
        file,
        time: fs.statSync(filePath).mtime.getTime()
      };
    })
    .sort((a, b) => b.time - a.time);

  return files.length > 0 ? files[0].file : null;
}

function detectDelimiter(text) {
  const firstLine = String(text || "").split(/\r?\n/)[0] || "";

  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;

  if (semicolonCount > commaCount && semicolonCount > tabCount) return ";";
  if (tabCount > commaCount && tabCount > semicolonCount) return "\t";

  return ",";
}

function normalizeHeader(header) {
  return String(header || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/_/g, "")
    .replace(/-/g, "")
    .replace(/\./g, "")
    .replace(/\//g, "")
    .replace(/\(/g, "")
    .replace(/\)/g, "")
    .replace(/:/g, "");
}

function mapRowToVehicle(row, options = {}) {
  const mode = options.mode || "auto";

  if (mode === "manual") {
    return mapRowToVehicleManual(row, options);
  }

  return mapRowToVehicleAuto(row, options);
}

function mapRowToVehicleAuto(row, options = {}) {
  const manualLeasing = options.manualLeasing || "";
  const manualCabang = options.manualCabang || "";
  const periodeData = options.periodeData || "";

  const nopol = getValue(row, [
    "nopol",
    "nopolisi",
    "nomorpolisi",
    "nopolis",
    "noplat",
    "nomorplat",
    "plat",
    "plate",
    "nokendaraan",
    "nomorkendaraan",
    "nomor",
    "polisi",
    "licenseplate",
    "vehicleplate"
  ]);

  const namaKendaraan = getValue(row, [
    "kendaraan",
    "namakendaraan",
    "unit",
    "namaunit",
    "tipe",
    "type",
    "merk",
    "merek",
    "model",
    "jeniskendaraan",
    "mobil",
    "motor",
    "vehicle",
    "vehiclename"
  ]);

  const tahun = getValue(row, [
    "tahun",
    "thn",
    "year",
    "tahununit",
    "tahunkendaraan",
    "tahunmobil"
  ]);

  const warna = getValue(row, [
    "warna",
    "color",
    "colour"
  ]);

  const noRangka = getValue(row, [
    "norangka",
    "nomorrangka",
    "rangka",
    "chassis",
    "nochassis",
    "chasis",
    "nochasis",
    "vin",
    "framenumber"
  ]);

  const noMesin = getValue(row, [
    "nomesin",
    "nomormesin",
    "mesin",
    "engine",
    "noengine",
    "engineno",
    "enginenumber"
  ]);

  const leasingFromFile = getValue(row, [
    "leasing",
    "lising",
    "finance",
    "pembiayaan",
    "perusahaanpembiayaan",
    "multifinance",
    "namaleasing",
    "namalising"
  ]);

  const cabangFromFile = getValue(row, [
    "cabang",
    "branch",
    "wilayah",
    "area",
    "region",
    "namacabang",
    "kantorcabang",
    "lokasicabang"
  ]);

  const leasing = leasingFromFile || manualLeasing;
  const cabang = cabangFromFile || manualCabang;

  const saldo = getValue(row, [
    "saldo",
    "bakidebet",
    "bakidebit",
    "outstanding",
    "os",
    "sisapinjaman",
    "sisaangsuran",
    "sisa",
    "tagihan"
  ]);

  const overdue = getValue(row, [
    "ovd",
    "dpd",
    "overdue",
    "overdueday",
    "keterlambatan",
    "telat",
    "hariovd",
    "haritelat",
    "pastdue"
  ]);

  const catatan = getValue(row, [
    "catatan",
    "keterangan",
    "ket",
    "note",
    "notes",
    "remark",
    "remarks",
    "info",
    "informasi"
  ]);

  return buildVehicle({
    nopol,
    namaKendaraan,
    tahun,
    warna,
    noRangka,
    noMesin,
    leasing,
    cabang,
    saldo,
    overdue,
    catatan,
    periodeData
  });
}

function mapRowToVehicleManual(row, options = {}) {
  const mapping = options.mapping || {};
  const manualLeasing = options.manualLeasing || "";
  const manualCabang = options.manualCabang || "";
  const periodeData = options.periodeData || "";

  const nopol = getMappedValue(row, mapping.nopol);
  const namaKendaraan = getMappedValue(row, mapping.namaKendaraan);
  const tahun = getMappedValue(row, mapping.tahun);
  const warna = getMappedValue(row, mapping.warna);
  const noRangka = getMappedValue(row, mapping.noRangka);
  const noMesin = getMappedValue(row, mapping.noMesin);

  const leasingFromFile = getMappedValue(row, mapping.leasing);
  const cabangFromFile = getMappedValue(row, mapping.cabang);

  const leasing = leasingFromFile || manualLeasing;
  const cabang = cabangFromFile || manualCabang;

  const saldo = getMappedValue(row, mapping.saldo);
  const overdue = getMappedValue(row, mapping.overdue);
  const catatan = getMappedValue(row, mapping.catatan);

  return buildVehicle({
    nopol,
    namaKendaraan,
    tahun,
    warna,
    noRangka,
    noMesin,
    leasing,
    cabang,
    saldo,
    overdue,
    catatan,
    periodeData
  });
}

function getMappedValue(row, mappedHeader) {
  if (!mappedHeader) return "";

  const key = normalizeHeader(mappedHeader);

  if (row[key] !== undefined && row[key] !== null) {
    return String(row[key]).trim();
  }

  return "";
}

function buildVehicle(data) {
  const nopol = data.nopol || "";
  const namaKendaraan = data.namaKendaraan || "";
  const tahun = data.tahun || "";
  const warna = data.warna || "";
  const noRangka = data.noRangka || "";
  const noMesin = data.noMesin || "";
  const leasing = data.leasing || "";
  const cabang = data.cabang || "";
  const saldo = data.saldo || "";
  const overdue = data.overdue || "";
  const catatan = data.catatan || "";
  const periodeData = data.periodeData || "";
  const nopolKey = generateNopolKey(nopol);

  return {
    nopol,
    nopolKey,
    groupNumber: extractGroupNumber(nopol),
    namaKendaraan,
    tahun,
    warna,
    noRangka,
    noMesin,
    leasing,
    cabang,
    saldo,
    overdue,
    catatan,
    periodeData,
    searchKey: makeSearchKey(
  nopol,
  nopolKey,
  namaKendaraan,
  warna,
  noRangka,
  noMesin,
  leasing,
  cabang,
  catatan
),
    sourceType: "ADMIN",
    status: "approved",
    updatedAt: new Date().toISOString()
  };
}

function getValue(row, aliases) {
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== null) {
      return String(row[alias]).trim();
    }
  }

  return "";
}

function generateNopolKey(nopol) {
  const clean = String(nopol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();

  const match = clean.match(/^([A-Z]{1,2})(\d{1,4})([A-Z]{0,4})$/);

  if (!match) return clean;

  const wilayah = match[1];
  const angka = match[2].padStart(4, "0");
  const seri = match[3] || "";

  return `${wilayah}${angka}${seri}`;
}

function normalizePeriodeData(value) {
  const clean = String(value || "").trim();

  if (!clean) return "";

  const match = clean.match(/^(0[1-9]|1[0-2])\/(\d{2})$/);
  if (!match) return "";

  return clean;
}

function extractGroupNumber(nopol) {
  if (!nopol) return "";

  const match = String(nopol).replace(/\s+/g, "").match(/\d+/);
  if (!match) return "";

  return match[0].substring(0, 4);
}

function makeSearchKey(...fields) {
  return normalizeText(fields.join(" "));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

app.get("/admin", (req, res) => {
  res.redirect("/admin/");
});

app.listen(PORT, () => {
  console.log(`noteBase server running on http://localhost:${PORT}`);
});