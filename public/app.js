const BASE_URL = "";

const btnCheckServer = document.getElementById("btnCheckServer");
const btnUpload = document.getElementById("btnUpload");
const btnGenerate = document.getElementById("btnGenerate");
const btnLatest = document.getElementById("btnLatest");
const btnReadHeaders = document.getElementById("btnReadHeaders");

const serverStatus = document.getElementById("serverStatus");
const totalRows = document.getElementById("totalRows");
const versionCode = document.getElementById("versionCode");
const csvFile = document.getElementById("csvFile");
const uploadStatus = document.getElementById("uploadStatus");
const generateStatus = document.getElementById("generateStatus");
const latestOutput = document.getElementById("latestOutput");

const manualLeasingInput = document.getElementById("manualLeasingInput");
const manualCabangInput = document.getElementById("manualCabangInput");
const mappingSection = document.getElementById("mappingSection");

const mapNopol = document.getElementById("mapNopol");
const mapKendaraan = document.getElementById("mapKendaraan");
const mapTahun = document.getElementById("mapTahun");
const mapWarna = document.getElementById("mapWarna");
const mapNoRangka = document.getElementById("mapNoRangka");
const mapNoMesin = document.getElementById("mapNoMesin");
const mapLeasing = document.getElementById("mapLeasing");
const mapCabang = document.getElementById("mapCabang");
const mapSaldo = document.getElementById("mapSaldo");
const mapOverdue = document.getElementById("mapOverdue");
const mapCatatan = document.getElementById("mapCatatan");

btnCheckServer.addEventListener("click", checkServer);
btnUpload.addEventListener("click", uploadCsv);
btnGenerate.addEventListener("click", generateUpdate);
btnLatest.addEventListener("click", getLatestUpdate);
btnReadHeaders.addEventListener("click", readHeaders);

async function checkServer() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    const data = await res.json();

    serverStatus.textContent = data.status === "ok" ? "Aktif" : "Error";
  } catch (error) {
    serverStatus.textContent = "Mati";
    alert("Gagal cek server: " + error.message);
  }
}

async function uploadCsv() {
  const file = csvFile.files[0];

  if (!file) {
    alert("Pilih file CSV dulu.");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  uploadStatus.textContent = "Sedang upload CSV...";

  try {
    const res = await fetch(`${BASE_URL}/api/admin/upload-csv`, {
      method: "POST",
      body: formData
    });

    const data = await res.json();

    if (!data.success) {
      throw new Error(data.message || "Upload gagal");
    }

    uploadStatus.textContent = `Upload berhasil: ${data.file.savedName}`;
    alert("CSV berhasil diupload.");
  } catch (error) {
    uploadStatus.textContent = "Upload gagal: " + error.message;
    alert("Upload gagal: " + error.message);
  }
}

async function readHeaders() {
  const file = csvFile.files[0];

  if (!file) {
    alert("Pilih file CSV dulu.");
    return;
  }

  try {
    const text = await file.text();
    const firstLine = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)[0];

    if (!firstLine) {
      alert("Header CSV tidak ditemukan.");
      return;
    }

    const delimiter = detectDelimiter(firstLine);
    const headers = splitCsvLine(firstLine, delimiter);

    fillMappingDropdowns(headers);
    mappingSection.classList.remove("hidden");

    uploadStatus.textContent = "Header berhasil dibaca. Silakan pilih mapping manual jika diperlukan.";
  } catch (error) {
    alert("Gagal baca header: " + error.message);
  }
}

async function generateUpdate() {
  const uploadMode = document.querySelector('input[name="uploadMode"]:checked')?.value || "auto";

  const payload = {
    mode: uploadMode,
    manualLeasing: manualLeasingInput.value.trim(),
    manualCabang: manualCabangInput.value.trim(),
    mapping: getMappingPayload()
  };

  if (uploadMode === "manual" && !payload.mapping.nopol) {
    alert("Mapping Nopol wajib dipilih.");
    return;
  }

  generateStatus.textContent = "Sedang generate SQLite.gz...";

  try {
    const res = await fetch(`${BASE_URL}/api/admin/generate-update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!data.success) {
      throw new Error(data.message || "Generate gagal");
    }

    generateStatus.textContent = `Generate berhasil: ${data.data.gzipFile}`;

    totalRows.textContent = data.data.totalRows;
    versionCode.textContent = data.data.versionCode;
    latestOutput.textContent = JSON.stringify(data.data, null, 2);

    alert("SQLite.gz berhasil dibuat.");
  } catch (error) {
    generateStatus.textContent = "Generate gagal: " + error.message;
    alert("Generate gagal: " + error.message);
  }
}

async function getLatestUpdate() {
  try {
    const res = await fetch(`${BASE_URL}/api/update/latest`);
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.message || "Belum ada update");
    }

    totalRows.textContent = data.data.totalRows;
    versionCode.textContent = data.data.versionCode;
    latestOutput.textContent = JSON.stringify(data.data, null, 2);
  } catch (error) {
    latestOutput.textContent = "Gagal ambil update: " + error.message;
  }
}

function fillMappingDropdowns(headers) {
  const selects = [
    mapNopol,
    mapKendaraan,
    mapTahun,
    mapWarna,
    mapNoRangka,
    mapNoMesin,
    mapLeasing,
    mapCabang,
    mapSaldo,
    mapOverdue,
    mapCatatan
  ];

  selects.forEach((select) => {
    select.innerHTML = "";

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "-- Tidak dipakai --";
    select.appendChild(emptyOption);

    headers.forEach((header) => {
      const option = document.createElement("option");
      option.value = normalizeHeader(header);
      option.textContent = header;
      select.appendChild(option);
    });
  });

  autoGuessMapping(headers);
}

function autoGuessMapping(headers) {
  const normalizedHeaders = headers.map(normalizeHeader);

  setAutoSelected(mapNopol, normalizedHeaders, [
    "nopol", "nopolisi", "nomorpolisi", "nopolis", "noplat",
    "nomorplat", "plat", "plate", "nokendaraan", "nomorkendaraan"
  ]);

  setAutoSelected(mapKendaraan, normalizedHeaders, [
    "kendaraan", "namakendaraan", "unit", "namaunit",
    "tipe", "type", "merk", "merek", "model"
  ]);

  setAutoSelected(mapTahun, normalizedHeaders, [
    "tahun", "thn", "year", "tahununit", "tahunkendaraan"
  ]);

  setAutoSelected(mapWarna, normalizedHeaders, [
    "warna", "color", "colour"
  ]);

  setAutoSelected(mapNoRangka, normalizedHeaders, [
    "norangka", "nomorrangka", "rangka", "chassis", "chasis", "vin"
  ]);

  setAutoSelected(mapNoMesin, normalizedHeaders, [
    "nomesin", "nomormesin", "mesin", "engine", "engineno"
  ]);

  setAutoSelected(mapLeasing, normalizedHeaders, [
    "leasing", "lising", "finance", "pembiayaan", "namaleasing"
  ]);

  setAutoSelected(mapCabang, normalizedHeaders, [
    "cabang", "branch", "wilayah", "area", "region", "namacabang"
  ]);

  setAutoSelected(mapSaldo, normalizedHeaders, [
    "saldo", "bakidebet", "bakidebit", "outstanding", "os"
  ]);

  setAutoSelected(mapOverdue, normalizedHeaders, [
    "ovd", "dpd", "overdue", "telat", "keterlambatan"
  ]);

  setAutoSelected(mapCatatan, normalizedHeaders, [
    "catatan", "keterangan", "ket", "note", "remark"
  ]);
}

function setAutoSelected(select, normalizedHeaders, aliases) {
  const foundIndex = normalizedHeaders.findIndex((header) => aliases.includes(header));

  if (foundIndex >= 0) {
    select.value = normalizedHeaders[foundIndex];
  }
}

function getMappingPayload() {
  return {
    nopol: mapNopol.value,
    namaKendaraan: mapKendaraan.value,
    tahun: mapTahun.value,
    warna: mapWarna.value,
    noRangka: mapNoRangka.value,
    noMesin: mapNoMesin.value,
    leasing: mapLeasing.value,
    cabang: mapCabang.value,
    saldo: mapSaldo.value,
    overdue: mapOverdue.value,
    catatan: mapCatatan.value
  };
}

function detectDelimiter(headerLine) {
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semicolonCount = (headerLine.match(/;/g) || []).length;
  const tabCount = (headerLine.match(/\t/g) || []).length;

  if (semicolonCount > commaCount && semicolonCount > tabCount) return ";";
  if (tabCount > commaCount && tabCount > semicolonCount) return "\t";
  return ",";
}

function splitCsvLine(line, delimiter = ",") {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === delimiter && !insideQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);

  return result.map((value) =>
    value
      .replace(/^"|"$/g, "")
      .replace(/""/g, '"')
      .trim()
  );
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

checkServer();
getLatestUpdate();