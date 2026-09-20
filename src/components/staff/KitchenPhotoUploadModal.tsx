'use client';

import React, { useState } from 'react';
import {
  X,
  Camera,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import { KitchenPhoto } from '@/types';

/**
 * 后厨照片上传弹窗（**当前不在任何地方渲染**）。
 *
 * 保留文件、摘掉入口的原因（三条都是"这会让顾客看到编造的食品安全结论"）：
 *
 *   1. **没有文件输入。** 整个弹窗里**不存在** `<input type="file">` ——
 *      "上传"只是在 4 个写死的 Unsplash 图片 URL 之间切换
 *      （`PRESET_PHOTO_TEMPLATES`）。也就是说员工点"拍照上传后厨"，
 *      发布到顾客端的是一张图库里的网图，不是这家店的后厨。
 *   2. **上传者自己给自己发合格证。** `handleSubmit` 里
 *      `verified: true` 是客户端写死的字面量，同时"质检人姓名 / 岗位职务"
 *      是两个可以随便填的文本框。没有任何独立审核环节。
 *   3. **后端不存在。** `src/lib/api.ts` 的 `staffApi.uploadKitchenPhoto()`
 *      明确抛 501（"kitchen photo upload has no backend yet;
 *      the previous version let the uploader self-verify, which is not
 *      acceptable"），`getKitchenPhotos()` 明确返回空数组。
 *
 * 另外 `handleSubmit` 里的 `setTimeout(..., 400)` 是**假装的上传耗时**：
 * 它不等待任何网络请求，只是让按钮看起来"在忙"。
 *
 * 编出来的食品安全结论会让顾客以为自己在看监管数据。等后端真的有了
 * 「照片上传 + 独立审核 + 真实温控记录」再把 `StaffPwa` 的入口接回来
 * —— 那时第 1、2 条的形态本来也要重写。
 */

/** 巡检分类的受控枚举。原型在 `onChange` 里用 `as any` 绕过了它，这里收窄回来。 */
const CATEGORIES = ['prep', 'sanitization', 'cold_storage', 'chef_inspection'] as const;
type KitchenCategory = (typeof CATEGORIES)[number];

const CATEGORY_LABEL: Record<KitchenCategory, string> = {
  sanitization: '晨检消杀',
  prep: '生鲜验收',
  cold_storage: '冷库温控',
  chef_inspection: '主厨质检',
};

/** `<select>` 的 value 是 string，必须显式收窄后才能进状态；不做断言。 */
function isKitchenCategory(value: string): value is KitchenCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

interface PresetPhotoTemplate {
  title: string;
  category: KitchenCategory;
  category_label: string;
  image_url: string;
  temperature_log: string;
  notes: string;
}

const PRESET_PHOTO_TEMPLATES: PresetPhotoTemplate[] = [
  {
    title: '生鲜三文鱼与和牛开箱中心温控抽检',
    category: 'prep',
    category_label: '生鲜验收',
    image_url: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=1000&q=80',
    temperature_log: '中心探针测温 1.9°C · 保鲜箱处于冰封状态',
    notes: '肉质鲜润无异味，产地溯源条码齐备，符合五星级生鲜验收红线标准。',
  },
  {
    title: '全自动高温洗碗舱与紫外线臭氧舱双重消毒',
    category: 'sanitization',
    category_label: '晨检消杀',
    image_url: 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=1000&q=80',
    temperature_log: '洗碗水温 85.5°C · 紫外线消毒 60 min',
    notes: '餐具表面微生物涂抹检测 0 菌落，已按标准化置入防尘无菌餐具保温柜。',
  },
  {
    title: '恒温急冻冷库与风冷果蔬仓实时巡视',
    category: 'cold_storage',
    category_label: '冷库温控',
    image_url: 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=1000&q=80',
    temperature_log: '蔬菜保鲜库 3.4°C · 深冷急冻柜 -20.2°C',
    notes: '除霜周期正常，温湿度传感报警系统运转良好，所有食材均贴封赏味签。',
  },
  {
    title: '晚市主厨试味巡检与精致摆盘出品标准验收',
    category: 'chef_inspection',
    category_label: '主厨质检',
    image_url: 'https://images.unsplash.com/photo-1577219491135-ce391730fb2c?auto=format&fit=crop&w=1000&q=80',
    temperature_log: '主厨试味 76°C · 摆盘加热保温灯 68°C',
    notes: '酱汁乳化饱满，牛排熟度五分熟精准，风味层次纯正，允许出品呈送贵宾。',
  },
];

interface KitchenPhotoUploadModalProps {
  onClose: () => void;
  onSuccess: (photo: KitchenPhoto) => void;
  defaultUploaderName?: string;
  defaultUploaderRole?: string;
}

export const KitchenPhotoUploadModal: React.FC<KitchenPhotoUploadModalProps> = ({
  onClose,
  onSuccess,
  defaultUploaderName = '主厨 Marco / 店长',
  defaultUploaderRole = '餐饮品控主管',
}) => {
  const [title, setTitle] = useState(PRESET_PHOTO_TEMPLATES[0].title);
  const [category, setCategory] = useState<KitchenCategory>(PRESET_PHOTO_TEMPLATES[0].category);
  const [categoryLabel, setCategoryLabel] = useState(PRESET_PHOTO_TEMPLATES[0].category_label);
  const [imageUrl, setImageUrl] = useState(PRESET_PHOTO_TEMPLATES[0].image_url);
  const [temperatureLog, setTemperatureLog] = useState(PRESET_PHOTO_TEMPLATES[0].temperature_log);
  const [notes, setNotes] = useState(PRESET_PHOTO_TEMPLATES[0].notes);
  const [uploaderName, setUploaderName] = useState(defaultUploaderName);
  const [uploaderRole, setUploaderRole] = useState(defaultUploaderRole);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSelectTemplate = (tpl: PresetPhotoTemplate) => {
    setTitle(tpl.title);
    setCategory(tpl.category);
    setCategoryLabel(tpl.category_label);
    setImageUrl(tpl.image_url);
    setTemperatureLog(tpl.temperature_log);
    setNotes(tpl.notes);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const nowStr = '今日 ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const newPhoto: KitchenPhoto = {
      id: `kpic_${Date.now()}`,
      title,
      category,
      category_label: categoryLabel,
      image_url: imageUrl,
      temperature_log: temperatureLog,
      notes,
      uploader_name: uploaderName,
      uploader_role: uploaderRole,
      uploaded_at: nowStr,
      // 见文件头第 2 条：合格证由上传者自己签发。
      verified: true,
    };

    setTimeout(() => {
      onSuccess(newPhoto);
      setIsSubmitting(false);
      onClose();
    }, 400);
  };

  return (
    <div
      id="upload-kitchen-modal-backdrop"
      className="fixed inset-0 z-60 bg-stone-950/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-stone-900 border border-stone-800 text-stone-100 rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-stone-950 px-5 py-4 border-b border-stone-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Camera className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white">员工/店长 · 今日后厨照片上传</h3>
              <p className="text-[11px] text-stone-400">上传后将实时同步至所有顾客端「一键看后厨」实况</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-stone-800 hover:bg-stone-700 text-stone-300 flex items-center justify-center transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 text-xs">
          {/* Preset Quick Templates */}
          <div>
            <label className="text-stone-400 font-medium block mb-1.5 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>快速套用标准巡检模版：</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {PRESET_PHOTO_TEMPLATES.map((tpl, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleSelectTemplate(tpl)}
                  className={`p-2 rounded-xl text-left border transition ${
                    title === tpl.title
                      ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-200 shadow-sm'
                      : 'bg-stone-800/60 border-stone-700/60 text-stone-300 hover:bg-stone-800'
                  }`}
                >
                  <div className="font-semibold text-[11px] truncate">{tpl.category_label}</div>
                  <div className="text-[10px] text-stone-400 truncate mt-0.5">{tpl.title}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="text-stone-300 font-semibold block mb-1">巡检实况标题</label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-stone-800 border border-stone-700 text-stone-100 text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
              placeholder="例：今日生鲜三文鱼开箱质检"
            />
          </div>

          {/* Category */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-stone-300 font-semibold block mb-1">巡检分类</label>
              <select
                value={category}
                onChange={(e) => {
                  const value = e.target.value;
                  // 非枚举值不动状态，也不猜一个默认分类 —— 猜出来的分类会进审计记录。
                  if (!isKitchenCategory(value)) return;
                  setCategory(value);
                  setCategoryLabel(CATEGORY_LABEL[value]);
                }}
                className="w-full px-3 py-2 rounded-xl bg-stone-800 border border-stone-700 text-stone-100 text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
              >
                <option value="sanitization">晨检消杀 (Sanitization)</option>
                <option value="prep">生鲜验收 (Prep & Sourcing)</option>
                <option value="cold_storage">冷库温控 (Cold Storage)</option>
                <option value="chef_inspection">主厨质检 (Chef Inspection)</option>
              </select>
            </div>

            <div>
              <label className="text-stone-300 font-semibold block mb-1">温控与传感器读数</label>
              <input
                type="text"
                value={temperatureLog}
                onChange={(e) => setTemperatureLog(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-stone-800 border border-stone-700 text-stone-100 text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                placeholder="例：2.1°C / 相对湿度 50%"
              />
            </div>
          </div>

          {/* Image URL & Preview */}
          <div>
            <label className="text-stone-300 font-semibold block mb-1">现场照片 URL (支持拍摄图片直连)</label>
            <input
              type="url"
              required
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-stone-800 border border-stone-700 text-stone-100 text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
            />
            {imageUrl && (
              <div className="mt-2 w-full h-32 rounded-xl overflow-hidden bg-stone-950 border border-stone-800">
                <img
                  src={imageUrl}
                  alt="预览"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="text-stone-300 font-semibold block mb-1">质检观察记录与执行标准</label>
            <textarea
              rows={2}
              required
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-stone-800 border border-stone-700 text-stone-100 text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
              placeholder="请输入本次消杀、食材验收或出品试吃的详细结论..."
            />
          </div>

          {/* Uploader Details */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-stone-300 font-semibold block mb-1">质检人姓名</label>
              <input
                type="text"
                required
                value={uploaderName}
                onChange={(e) => setUploaderName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-stone-800 border border-stone-700 text-stone-100 text-xs"
              />
            </div>
            <div>
              <label className="text-stone-300 font-semibold block mb-1">岗位职务</label>
              <input
                type="text"
                required
                value={uploaderRole}
                onChange={(e) => setUploaderRole(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-stone-800 border border-stone-700 text-stone-100 text-xs"
              />
            </div>
          </div>

          {/* Submit */}
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 font-medium transition"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition flex items-center gap-1.5 shadow-lg shadow-emerald-900/40"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{isSubmitting ? '上传发布中...' : '发布到顾客端透明后厨'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
