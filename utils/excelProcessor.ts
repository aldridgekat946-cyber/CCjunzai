
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { GoogleGenAI, Type } from "@google/genai";
import { Box1Data, ProcessedRow } from '../types';

const normalize = (s: any): string => {
  if (s === null || s === undefined) return "";
  const str = typeof s === 'object' ? (s.text || s.result || String(s)) : String(s);
  return str.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
};

const getCellValue = (cell: ExcelJS.Cell): any => {
  const val = cell.value;
  if (val === null || val === undefined) return "";
  if (typeof val === 'object' && 'result' in val) return val.result ?? "";
  if (typeof val === 'object' && 'text' in val) return val.text ?? "";
  if (typeof val === 'object' && 'richText' in val) return (val as any).richText.map((t: any) => t.text).join("");
  return val;
};

const findColIndex = (headers: any[], possibleNames: string[]): number => {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || "").trim().toUpperCase();
    if (possibleNames.some(name => h.includes(name.toUpperCase()))) return i;
  }
  return -1;
};

/**
 * Robust retry helper with exponential backoff and jitter to handle 429 Quota errors.
 */
async function callWithRetry<T>(
  fn: () => Promise<T>, 
  onRetry?: (msg: string) => void,
  maxRetries: number = 3, 
  initialDelay: number = 2000
): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const isQuotaError = JSON.stringify(error).includes('429') || error.message?.includes('429');
      
      if (isQuotaError && i < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, i);
        onRetry?.(`API 繁忙，正在重试 (${i + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Fetch part info using Google Search for the fastest/most comprehensive result.
 */
async function fetchPartInfoFromAI(oe: string, onProgress?: (msg: string) => void): Promise<{ productName: string, model: string, generalOE: string }> {
  return await callWithRetry(async () => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Search Google for automotive part information for OE: "${oe}". 
      Return structured JSON:
      1. productName: Brief part type (e.g. Starter).
      2. model: Concise vehicle compatibility.
      3. generalOE: List all cross-reference OE numbers found, comma separated.`,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 }, // Minimize latency
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            productName: { type: Type.STRING },
            model: { type: Type.STRING },
            generalOE: { type: Type.STRING },
          },
          required: ["productName", "model", "generalOE"]
        }
      }
    });

    const jsonStr = response.text;
    if (jsonStr) {
      return JSON.parse(jsonStr);
    }
    throw new Error("Empty AI response");
  }, onProgress);
}

// Global reference for highlighting matches in exported Excel
let globalRefMap: Record<string, any> = {};

export const processFiles = async (
  fileReference: File,
  fileOe: File,
  onProgress?: (msg: string) => void
): Promise<ProcessedRow[]> => {
  onProgress?.("正在读取参考数据库...");
  const refBuffer = await fileReference.arrayBuffer();
  const refWorkbook = new ExcelJS.Workbook();
  await refWorkbook.xlsx.load(refBuffer);
  const refWorksheet = refWorkbook.worksheets[0];

  let headerRowIndex = 1;
  let oemColIdx = -1;
  for (let i = 1; i <= 20; i++) {
    const rowValues = refWorksheet.getRow(i).values as any[];
    oemColIdx = findColIndex(rowValues, ['OEM', 'OE', '原厂编号', '零件号']);
    if (oemColIdx !== -1) { headerRowIndex = i; break; }
  }

  if (oemColIdx === -1) throw new Error("参考数据库中未找到 OEM 相关列。");

  const headers = refWorksheet.getRow(headerRowIndex).values as any[];
  const xxColIdx = findColIndex(headers, ['XX CODE', 'XX编码']);
  const appColIdx = findColIndex(headers, ['Application', '适用车型', '车型']);
  const yearColIdx = findColIndex(headers, ['Year', '年份']);
  const driveColIdx = findColIndex(headers, ['Drive', '驱动']);
  const priceColIdx = findColIndex(headers, ['广州', 'Price', '价格']);
  const prodColIdx = findColIndex(headers, ['Product', '名称', '产品名']);

  const imageMap: Record<number, { buffer: ArrayBuffer; extension: string }> = {};
  refWorksheet.getImages().forEach((image) => {
    const img = refWorkbook.model.media.find((m: any, idx: number) => idx === (image as any).imageId || m.index === (image as any).imageId);
    if (img && image.range.tl.nativeRow + 1) {
      imageMap[image.range.tl.nativeRow + 1] = { buffer: img.buffer, extension: img.extension };
    }
  });

  const mapRef: Record<string, Box1Data> = {};
  refWorksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowIndex) return;
    const oemRaw = getCellValue(row.getCell(oemColIdx));
    if (!oemRaw) return;
    const tokens = String(oemRaw).split(/[\s\n,;:/|，；、]+/);
    const imageData = imageMap[rowNumber] || null;
    for (const token of tokens) {
      const norm = normalize(token);
      if (norm && norm.length > 2) {
        mapRef[norm] = {
          xxCode: xxColIdx !== -1 ? String(getCellValue(row.getCell(xxColIdx)) || "") : "",
          application: appColIdx !== -1 ? String(getCellValue(row.getCell(appColIdx)) || "") : "",
          year: yearColIdx !== -1 ? String(getCellValue(row.getCell(yearColIdx)) || "") : "",
          oem: String(oemRaw),
          drive: driveColIdx !== -1 ? String(getCellValue(row.getCell(driveColIdx)) || "") : "",
          picture: "已提取",
          productName: prodColIdx !== -1 ? String(getCellValue(row.getCell(prodColIdx)) || "") : "",
          price: priceColIdx !== -1 ? getCellValue(row.getCell(priceColIdx)) : null,
          imageData: imageData
        };
      }
    }
  });

  globalRefMap = mapRef;

  onProgress?.("正在读取待处理 OE 列表...");
  const bufOe = await fileOe.arrayBuffer();
  const wbOe = XLSX.read(bufOe, { type: 'array' });
  const wsOe = wbOe.Sheets[wbOe.SheetNames[0]];
  const dataOeRaw = XLSX.utils.sheet_to_json<any[]>(wsOe, { header: 1 });
  
  let oeInputCol = 0;
  if (dataOeRaw.length > 0) {
    const firstRow = dataOeRaw[0];
    const detectedIdx = findColIndex(firstRow, ['OE', 'OEM', '查询', '输入']);
    if (detectedIdx !== -1) oeInputCol = detectedIdx - 1; 
    if (oeInputCol < 0) oeInputCol = 0;
  }

  const results: ProcessedRow[] = [];
  const startIdx = findColIndex(dataOeRaw[0], ['OE', 'OEM']) !== -1 ? 1 : 0;

  for (let i = startIdx; i < dataOeRaw.length; i++) {
    const row = dataOeRaw[i];
    if (!row || row.length === 0) continue;
    const inputOE = String(row[oeInputCol] || "").trim();
    if (!inputOE) continue;
    
    const normInput = normalize(inputOE);
    const match = mapRef[normInput];

    const newRow: ProcessedRow = {
      '输入 OE': inputOE,
      'XX 编码': null,
      '适用车型': null,
      '年份': null,
      'OEM': null,
      '驱动': null,
      '图片': null,
      '图片数据': null,
      '广州价': null,
      '产品名': null,
      '车型': null,
      '通用OE': null
    };

    if (match) {
      newRow['XX 编码'] = match.xxCode;
      newRow['适用车型'] = match.application;
      newRow['年份'] = match.year;
      newRow['OEM'] = match.oem;
      newRow['驱动'] = match.drive;
      newRow['图片'] = match.imageData ? "匹配成功" : "无图片";
      newRow['图片数据'] = match.imageData;
      newRow['广州价'] = match.price;
      newRow['产品名'] = match.productName;
    } else {
      onProgress?.(`库内未找到 OE ${inputOE}，谷歌 AI 检索中...`);
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const aiInfo = await fetchPartInfoFromAI(inputOE, onProgress);
        newRow['产品名'] = aiInfo.productName;
        newRow['车型'] = aiInfo.model;
        newRow['通用OE'] = aiInfo.generalOE;
      } catch (err) {
        console.error(`AI Fetch Error:`, err);
        newRow['产品名'] = "检索失败";
        newRow['车型'] = "-";
        newRow['通用OE'] = "-";
      }
    }

    results.push(newRow);
  }

  return results;
};

export const exportToExcel = async (data: ProcessedRow[], fileName: string) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('匹配结果');

  const columns = ['输入 OE', 'XX 编码', '适用车型', '年份', 'OEM', '驱动', '图片', '广州价', '产品名', '车型', '通用OE'];
  worksheet.columns = columns.map(c => ({ 
    header: c, 
    key: c, 
    width: (c === 'OEM' || c === '适用车型' || c === '车型' || c === '通用OE' || c === '产品名') ? 35 : (c === '图片' ? 34 : 15)
  }));

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).height = 25;
  worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

  for (let i = 0; i < data.length; i++) {
    const rowData = data[i];
    const excelRow = worksheet.addRow({});
    const rowNumber = i + 2;
    excelRow.height = 80; 
    excelRow.alignment = { vertical: 'middle', horizontal: 'center' };

    columns.forEach((col, colIdx) => {
      const cell = excelRow.getCell(colIdx + 1);
      const val = rowData[col];

      if (col === '图片' && rowData['图片数据']) {
        const imgData = rowData['图片数据'];
        try {
          const imageId = workbook.addImage({ buffer: imgData.buffer, extension: imgData.extension as any });
          worksheet.addImage(imageId, {
            tl: { col: colIdx, row: rowNumber - 1, nativeColOff: 12 * 9525, nativeRowOff: 0 },
            ext: { width: 227, height: 81 },
            editAs: 'oneCell'
          });
        } catch (e) { console.error(e); }
        cell.value = "";
      } else if (col === 'OEM' || col === '通用OE') {
        cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
        const text = String(val || "");
        const parts = text.split(/([\s\n,;:/|，；、]+)/);
        const richText: any[] = [];
        
        parts.forEach(part => {
          if (!part) return;
          const normPart = normalize(part);
          const isDelimiter = /^[\s\n,;:/|，；、]+$/.test(part);
          
          if (isDelimiter) {
            richText.push({ text: part });
          } else {
            // Highlight Input OE match in OEM column (Red)
            if (col === 'OEM' && normPart === normalize(rowData['输入 OE'])) {
              richText.push({ text: part, font: { color: { argb: 'FFFF0000' }, bold: true } });
            } 
            // Highlight Reference Match in General OE column (Green)
            else if (col === '通用OE' && globalRefMap[normPart]) {
              richText.push({ text: part, font: { color: { argb: 'FF00B050' }, bold: true } });
            } 
            else {
              richText.push({ text: part });
            }
          }
        });
        cell.value = { richText };
      } else {
        cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
        cell.value = val;
      }
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.URL.revokeObjectURL(url);
};
