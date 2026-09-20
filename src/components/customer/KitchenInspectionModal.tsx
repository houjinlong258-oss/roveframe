'use client';

import React, { useState } from 'react';
import {
  X,
  ShieldCheck,
  Thermometer,
  CheckCircle2,
  Clock,
  Award,
  Eye,
  Camera,
} from 'lucide-react';
import { KitchenPhoto } from '@/types';

/**
 * 后厨巡检弹窗（**当前不在任何地方渲染**）。
 *
 * 保留文件、摘掉入口的原因：
 *   · 合规横幅上的「Grade A 卓越 / 1.8°C~2.3°C / 4 次全区巡查」是写死的字面量，
 *     不是任何真实检测数据；
 *   · 上传链路让上传者自己写 `verified: true` —— 自己给自己发合格证；
 *   · `customerApi.getKitchenPhotos()` 目前明确返回空数组并打日志
 *     （src/lib/api.ts 文件头第 3 条 + `getKitchenPhotos`）—— 后端没有照片表，
 *     也没有审核记录。
 *
 * 编出来的食品安全结论会让顾客以为自己在看监管数据。等后端真的有了
 * 「照片上传 + 独立审核 + 真实温控记录」再把 `CustomerPwa` 的入口接回来。
 */

interface KitchenInspectionModalProps {
  photos: KitchenPhoto[];
  onClose: () => void;
  onOpenUpload?: () => void;
  canUpload?: boolean;
}

export const KitchenInspectionModal: React.FC<KitchenInspectionModalProps> = ({
  photos,
  onClose,
  onOpenUpload,
  canUpload = false,
}) => {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [selectedPhoto, setSelectedPhoto] = useState<KitchenPhoto | null>(null);

  const categories = [
    { key: 'all', label: '全部巡检' },
    { key: 'sanitization', label: '晨检消杀' },
    { key: 'prep', label: '生鲜验收' },
    { key: 'cold_storage', label: '冷库温控' },
    { key: 'chef_inspection', label: '主厨质检' },
  ];

  const filteredPhotos =
    activeCategory === 'all'
      ? photos
      : photos.filter((p) => p.category === activeCategory);

  return (
    <div
      id="kitchen-inspection-backdrop"
      className="fixed inset-0 z-50 bg-stone-950/80 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        id="kitchen-inspection-card"
        className="w-full max-w-2xl bg-stone-900 border border-stone-800 text-stone-100 rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col animate-in fade-in slide-in-from-bottom-6 duration-250"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="bg-gradient-to-r from-emerald-950/90 via-stone-900 to-stone-900 px-5 py-4 border-b border-stone-800/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0 shadow-inner">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-serif font-bold text-base text-white tracking-wide">
                  阳光透明后厨 · 每日巡检实况
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">
                  100% 官方每日核验
                </span>
              </div>
              <p className="text-[11px] text-stone-400 mt-0.5">
                主厨与品控团队每日清晨定点拍摄上传，食材溯源与消杀温控完全公开
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {canUpload && onOpenUpload && (
              <button
                onClick={onOpenUpload}
                className="px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold flex items-center gap-1.5 transition shadow"
                title="员工/老板上传新照片"
              >
                <Camera className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">上传今日实况</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-stone-800 hover:bg-stone-700 text-stone-300 hover:text-white flex items-center justify-center transition border border-stone-700/60"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Safety & Compliance Telemetry Banner */}
        <div className="bg-stone-950/60 border-b border-stone-800/60 px-5 py-3 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="bg-stone-900/60 rounded-xl p-2 border border-stone-800/80">
            <div className="text-[10px] text-stone-400 flex items-center justify-center gap-1">
              <Thermometer className="w-3 h-3 text-cyan-400" />
              <span>智能冷链温控</span>
            </div>
            <div className="text-cyan-300 font-bold font-mono text-xs mt-0.5">
              1.8°C ~ 2.3°C
            </div>
          </div>
          <div className="bg-stone-900/60 rounded-xl p-2 border border-stone-800/80">
            <div className="text-[10px] text-stone-400 flex items-center justify-center gap-1">
              <Clock className="w-3 h-3 text-emerald-400" />
              <span>今日巡检频次</span>
            </div>
            <div className="text-emerald-300 font-bold font-mono text-xs mt-0.5">
              4 次全区巡查
            </div>
          </div>
          <div className="bg-stone-900/60 rounded-xl p-2 border border-stone-800/80">
            <div className="text-[10px] text-stone-400 flex items-center justify-center gap-1">
              <Award className="w-3 h-3 text-amber-400" />
              <span>卫检评级</span>
            </div>
            <div className="text-amber-300 font-bold font-mono text-xs mt-0.5">
              Grade A 卓越
            </div>
          </div>
        </div>

        {/* Category Filters */}
        <div className="px-5 py-2.5 bg-stone-900/40 border-b border-stone-800/40 flex gap-2 overflow-x-auto scrollbar-none">
          {categories.map((c) => (
            <button
              key={c.key}
              onClick={() => setActiveCategory(c.key)}
              className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
                activeCategory === c.key
                  ? 'bg-emerald-700 text-white shadow-sm ring-1 ring-emerald-500'
                  : 'bg-stone-800/80 text-stone-400 hover:text-stone-200 hover:bg-stone-800'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Photos Grid */}
        <div className="p-5 overflow-y-auto space-y-4">
          {filteredPhotos.length === 0 ? (
            <div className="text-center py-12 text-stone-400 text-xs">
              暂无该分类的后厨巡检照片
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {filteredPhotos.map((photo) => (
                <div
                  key={photo.id}
                  className="bg-stone-800/50 border border-stone-700/70 rounded-2xl overflow-hidden shadow-md hover:border-emerald-500/50 transition-all flex flex-col group cursor-pointer"
                  onClick={() => setSelectedPhoto(photo)}
                >
                  {/* Image Container */}
                  <div className="relative w-full h-44 bg-stone-950 overflow-hidden">
                    <img
                      src={photo.image_url}
                      alt={photo.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-stone-900 via-transparent to-transparent opacity-80" />

                    {/* Category Label Pill */}
                    <div className="absolute top-3 left-3">
                      <span className="px-2.5 py-1 rounded-full bg-stone-900/85 backdrop-blur-md border border-emerald-500/40 text-emerald-300 text-[11px] font-semibold flex items-center gap-1 shadow">
                        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        <span>{photo.category_label || photo.category}</span>
                      </span>
                    </div>

                    {/* Time Pill */}
                    <div className="absolute top-3 right-3">
                      <span className="px-2 py-0.5 rounded-md bg-stone-950/80 backdrop-blur-md text-stone-300 text-[10px] font-mono border border-stone-800">
                        {photo.uploaded_at}
                      </span>
                    </div>

                    {/* Zoom preview hint */}
                    <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="px-2 py-1 rounded-lg bg-stone-900/90 text-stone-200 text-[10px] flex items-center gap-1 shadow">
                        <Eye className="w-3 h-3" />
                        <span>放大查看原图</span>
                      </span>
                    </div>
                  </div>

                  {/* Metadata Content */}
                  <div className="p-3.5 flex-1 flex flex-col justify-between space-y-2">
                    <div>
                      <h4 className="font-semibold text-white text-xs sm:text-sm tracking-tight leading-snug">
                        {photo.title}
                      </h4>
                      <p className="text-[11px] text-stone-400 mt-1 line-clamp-2 leading-relaxed font-sans">
                        {photo.notes}
                      </p>
                    </div>

                    <div className="pt-2 border-t border-stone-700/50 space-y-1 text-[10px]">
                      {photo.temperature_log && (
                        <div className="text-cyan-300 flex items-center gap-1.5 font-mono">
                          <Thermometer className="w-3 h-3 text-cyan-400 shrink-0" />
                          <span className="truncate">{photo.temperature_log}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-stone-400">
                        <span>质检人: <strong className="text-stone-200">{photo.uploader_name}</strong></span>
                        <span className="text-[9px] text-stone-500 font-mono">{photo.uploader_role}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Guarantee */}
        <div className="p-3.5 bg-stone-950 border-t border-stone-800 flex items-center justify-between text-[11px] text-stone-400">
          <div className="flex items-center gap-1.5 text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Grove Bistro 食品安全保障承诺：坚持每日原汁原味真实公开</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-medium transition"
          >
            返回菜单
          </button>
        </div>
      </div>

      {/* High-res Image Lightbox Modal */}
      {selectedPhoto && (
        <div
          className="fixed inset-0 z-60 bg-black/90 flex flex-col items-center justify-center p-4 backdrop-blur-md"
          onClick={() => setSelectedPhoto(null)}
        >
          <div
            className="relative max-w-3xl w-full bg-stone-900 border border-stone-800 rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-stone-800 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm text-white">{selectedPhoto.title}</h3>
                <p className="text-xs text-stone-400 mt-0.5">
                  上传时间: {selectedPhoto.uploaded_at} · 质检人: {selectedPhoto.uploader_name} ({selectedPhoto.uploader_role})
                </p>
              </div>
              <button
                onClick={() => setSelectedPhoto(null)}
                className="w-8 h-8 rounded-full bg-stone-800 hover:bg-stone-700 text-white flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="max-h-[60vh] bg-black flex items-center justify-center overflow-hidden">
              <img
                src={selectedPhoto.image_url}
                alt={selectedPhoto.title}
                referrerPolicy="no-referrer"
                className="max-h-[60vh] w-auto object-contain"
              />
            </div>

            <div className="p-4 bg-stone-950 text-xs text-stone-300 space-y-2">
              <p className="leading-relaxed">{selectedPhoto.notes}</p>
              {selectedPhoto.temperature_log && (
                <div className="p-2.5 rounded-xl bg-stone-900 border border-stone-800 text-cyan-300 font-mono text-[11px] flex items-center gap-2">
                  <Thermometer className="w-4 h-4 text-cyan-400" />
                  <span>实时温控记录：{selectedPhoto.temperature_log}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
