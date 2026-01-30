
import React, { useState, useEffect } from 'react';
import { ProcessedRow } from '../types';
import { ChevronLeft, ChevronRight, Download, ImageIcon, Sparkles } from 'lucide-react';

interface ResultsTableProps {
  data: ProcessedRow[];
  onExport: () => void;
}

const ImagePreview: React.FC<{ data?: { buffer: ArrayBuffer; extension: string } | null }> = ({ data }) => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (data?.buffer) {
      const blob = new Blob([data.buffer], { type: `image/${data.extension}` });
      const objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }
  }, [data]);

  if (!url) return <div className="flex items-center justify-center w-24 h-9 bg-slate-100 rounded text-slate-400"><ImageIcon size={16} /></div>;

  return (
    <img 
      src={url} 
      alt="Preview" 
      className="w-24 h-9 object-cover rounded border border-slate-200 shadow-sm" 
      style={{ aspectRatio: '60 / 21.5' }}
    />
  );
};

const normalize = (s: any): string => {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
};

const ResultsTable: React.FC<ResultsTableProps> = ({ data, onExport }) => {
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 10;
  
  const totalPages = Math.ceil(data.length / rowsPerPage);
  const startIndex = (currentPage - 1) * rowsPerPage;
  const currentData = data.slice(startIndex, startIndex + rowsPerPage);

  // We need the local database reference to highlight General OE matches.
  // In this client-side context, we assume anything that isn't a "hit" from AI (i.e. has XX编码) is in our reference map.
  // For UI highlighting, we can infer matches based on the current full data set.
  const knownOEs = new Set<string>();
  data.forEach(row => {
    if (row['XX 编码']) {
      const oemText = String(row['OEM'] || "");
      oemText.split(/[\s\n,;:/|，；、]+/).forEach(token => {
        const norm = normalize(token);
        if (norm.length > 2) knownOEs.add(norm);
      });
    }
  });

  const columns = [
    '输入 OE',
    'XX 编码',
    '适用车型',
    '年份',
    'OEM',
    '图片',
    '广州价',
    '产品名',
    '车型',
    '通用OE'
  ];

  const renderCellValue = (row: ProcessedRow, col: string) => {
    const val = row[col];
    if (val === null || val === undefined) return <span className="text-slate-300 italic">-</span>;
    
    const textValue = String(val);

    if (col === 'OEM' || col === '通用OE') {
      const parts = textValue.split(/([\s\n,;:/|，；、]+)/);
      return (
        <span className="text-slate-600 break-words">
          {parts.map((part, i) => {
            const norm = normalize(part);
            const isDelimiter = /^[\s\n,;:/|，；、]+$/.test(part);
            
            if (isDelimiter) return <span key={i}>{part}</span>;
            
            // Highlight Input OE match in OEM (Red)
            if (col === 'OEM' && norm === normalize(row['输入 OE'])) {
              return <span key={i} className="text-red-600 font-bold">{part}</span>;
            }
            // Highlight Reference Database match in General OE (Green)
            if (col === '通用OE' && knownOEs.has(norm)) {
              return <span key={i} className="text-emerald-600 font-bold underline decoration-emerald-200">{part}</span>;
            }
            
            return <span key={i}>{part}</span>;
          })}
        </span>
      );
    }

    return (
      <span className={
        col === '输入 OE' ? 'font-medium text-slate-900' : 
        (col === '车型' || col === '产品名') && !row['XX 编码'] ? 'text-indigo-600 italic' :
        'text-slate-600'
      }>
        {col === '产品名' && !row['XX 编码'] && <Sparkles size={12} className="inline mr-1 text-indigo-400" />}
        {textValue}
      </span>
    );
  };

  if (data.length === 0) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden animate-fade-in">
      <div className="flex items-center justify-between p-4 border-b border-slate-100 bg-slate-50/50">
        <div>
          <h3 className="text-lg font-bold text-slate-800">匹配结果</h3>
          <p className="text-sm text-slate-500">共 {data.length} 条记录 (含 Google AI 深度检索)</p>
        </div>
        <button 
          onClick={onExport}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
        >
          <Download size={16} />
          导出包含高亮结果的 Excel
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left table-fixed">
          <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-100">
            <tr>
              <th className="w-12 px-4 py-3 font-semibold text-center">#</th>
              {columns.map(col => (
                <th key={col} className={`px-4 py-3 font-semibold whitespace-nowrap ${
                  (col === '车型' || col === '通用OE' || col === 'OEM' || col === '产品名' || col === '适用车型') ? 'w-48' : 'w-32'
                }`}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {currentData.map((row, idx) => (
              <tr key={startIndex + idx} className="hover:bg-slate-50 transition-colors">
                <td className="px-4 py-3 text-slate-400 font-mono text-xs text-center">{startIndex + idx + 1}</td>
                {columns.map((col) => (
                  <td key={col} className={`px-4 py-3 align-middle ${
                    (col === '车型' || col === '通用OE' || col === 'OEM' || col === '产品名' || col === '适用车型') ? 'whitespace-normal' : 'truncate'
                  }`}>
                    {col === '图片' ? (
                      <ImagePreview data={row['图片数据']} />
                    ) : (
                      renderCellValue(row, col)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50/50">
        <div className="text-xs text-slate-500">
          显示第 {startIndex + 1} 至 {Math.min(startIndex + rowsPerPage, data.length)} 条，共 {data.length} 条
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
          <span className="flex items-center text-xs font-medium text-slate-600 px-2">
            第 {currentPage} 页 / 共 {totalPages} 页
          </span>
          <button
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ResultsTable;
