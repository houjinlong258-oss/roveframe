/**
 * Phase 18 TypeScript Interfaces & Contract Models
 * Strict parity with backend DDL and §7 contract specs
 */

export type Locale = 'zh' | 'en' | 'es';

export type CustomerMode = 'dine_in' | 'delivery' | 'booking' | 'menu';

// ----------------------------------------------------
// 7.1 Customer Endpoints Models
// ----------------------------------------------------

export interface StoreProfile {
  name: string;
  intro: string;
  hours: string;
  currency: string;
  logo_url?: string;
}

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: string; // e.g. "12.00"
  description: string;
  image_url: string;
  video_url: string | null;
  sales_count: number;
  allergens?: string[];
  cuisine_type?: string;
  story?: string;
  culinary_craft?: string;
  provenance?: string[];
  tasting_notes?: string[];
  pairing_recommendation?: string;
  chef_badge?: string;
  calories?: number;
}

export interface KitchenPhoto {
  id: string;
  image_url: string;
  title: string;
  category: 'prep' | 'sanitization' | 'chef_inspection' | 'cold_storage' | 'plating';
  category_label: string;
  uploader_name: string;
  uploader_role: string;
  uploaded_at: string;
  temperature_log?: string;
  notes?: string;
  verified: boolean;
}

export interface StoreMenuResponse {
  store: StoreProfile;
  table: string | null; // e.g. "A1" in dine-in, "WEB" in delivery
  categories: string[];
  products: MenuItem[];
}

export interface OrderItemPayload {
  product_id: string;
  qty: number;
}

export interface DineInOrderRequest {
  token: string;
  items: OrderItemPayload[];
  notes?: string;
  tip?: number;
  tip_rate?: number;
  idempotency_key: string;
}

export interface DineInOrderResponse {
  order_no: string;
  total: number;
  id: string;
}

export interface DeliveryOrderRequest {
  token: string;
  items: OrderItemPayload[];
  recipient_name: string;
  recipient_phone: string;
  address_line: string;
  address_note?: string;
  customer_address_id?: string | null;
  notes?: string;
  tip?: number;
  tip_rate?: number;
  idempotency_key: string;
  /**
   * 顾客**设备**定位（可选，需顾客显式授权）。
   *
   * 这是收货坐标唯一诚实的来源 —— 我们不对地址文本做地理编码（猜错会让 ETA
   * 与地图一起错，而顾客无从分辨）。顾客拒绝授权时**两个字段都不传**，
   * 服务端写入 NULL，追踪页据此保持"尚未获取目的地坐标"。
   * 只传一个或者传非法值会被服务端以 400 拒绝（fail-closed）。
   */
  dest_lat?: number;
  dest_lng?: number;
}

export interface DeliveryOrderResponse {
  order_id: string;
  order_no: string;
  subtotal: number;
  fee: number;
  tip?: number;
  total: number;
  promised_at: string;
  /** 追踪接口要的是这个 id（不是 order_id），见 CustomerOrderSummary.delivery_id。 */
  delivery_id?: string;
  /** 服务端确认写入的收货坐标；未授权定位时为 null。 */
  destination_coordinates?: { lat: number; lng: number } | null;
}

export interface SiteConfigResponse {
  store: {
    name: string;
    currency: string;
    hours: string;
  };
  modes: {
    dine_in: boolean;
    delivery: boolean;
    booking: boolean;
    menu: boolean;
  };
  delivery: {
    minOrderAmount: number;
    fee: number;
    freeDeliveryAbove: number;
    prepMinutes: number;
  };
  theme: {
    primary: string;
    accent: string;
    surface: string;
    font: string;
  };
}

export interface ReservationRequest {
  slug: string;
  customer_name: string;
  phone: string;
  party_size: number;
  reserved_at: string; // ISO
  notes?: string;
}

export interface ReservationResponse {
  ok: boolean;
  id: string;
}

export interface CustomerAccount {
  id: string;
  email: string;
  display_name: string;
  phone?: string;
}

export interface CustomerAddress {
  id: string;
  label: string;
  recipient_name: string;
  recipient_phone: string;
  address_line: string;
  address_note: string;
  is_default: boolean;
}

export interface RiderInfo {
  id: string;
  name: string;
  phone: string;
  avatar: string;
  rating: number;
  total_deliveries: number;
  vehicle: string;
  vehicle_plate: string;
  battery_level: number;
  temperature: string;
  health_certified: boolean;
  status_text: string;
  speed_kmh: number;
  distance_km: number;
  eta_minutes: number;
}

export interface DeliveryCoordinates {
  store_lat: number;
  store_lng: number;
  store_name: string;
  store_address: string;
  dest_lat: number;
  dest_lng: number;
  dest_address: string;
  rider_lat: number;
  rider_lng: number;
  progress_pct: number;
}

export interface CustomerOrderSummary {
  id: string;
  order_no: string;
  /**
   * 对应的 `delivery_orders.id`（仅外卖单）。
   *
   * 追踪接口 `/api/store/deliveries/{id}/track` 按 **delivery id** 查，
   * 而订单接口天然只给 order id —— 两者不同。缺这个字段时客户端只能拿
   * order id 去试，结果永远是 404（地图与 ETA 因此不可达）。
   */
  delivery_id?: string | null;
  channel: 'dine_in' | 'delivery' | 'booking';
  status: 'pending' | 'preparing' | 'on_the_way' | 'completed' | 'cancelled';
  total: number;
  subtotal?: number;
  fee?: number;
  tip?: number;
  tip_rate?: number;
  created_at: string;
  promised_at?: string;
  recipient_name?: string;
  recipient_phone?: string;
  rider_status?: 'unclaimed' | 'claimed' | 'picked_up' | 'delivered';
  items?: { name: string; qty: number; price: string }[];
  address_line?: string;
  address_note?: string;
  rider?: RiderInfo;
  coordinates?: DeliveryCoordinates;
}

// ----------------------------------------------------
// 7.2 Staff Endpoints Models
// ----------------------------------------------------

export interface StaffMeResponse {
  staff: {
    id: string;
    name: string;
    position: string;
    photo_url: string | null;
    hired_at?: string;
  };
  business: {
    id: string;
    name: string;
  };
  role: 'staff' | 'manager' | 'owner';
  preferences: {
    personal_data_opt_in: boolean;
  };
}

export interface StaffAttendanceRecord {
  id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  worked_minutes: number | null;
  clock_in_source?: string;
}

export interface StaffAttendanceActionResponse {
  action: 'clock_in' | 'clock_out';
  at: string;
  attendance_id: string;
  worked_minutes?: number;
}

export interface StaffShift {
  id: string;
  starts_at: string;
  ends_at: string;
  role: string;
  note: string;
}

export interface StaffDeliveryItem {
  id: string;
  order_no: string;
  address_line: string;
  recipient_phone: string;
  recipient_name?: string;
  total: number;
  created_at: string;
  promised_at: string;
  items_summary: string;
  rider_status?: 'unclaimed' | 'claimed' | 'picked_up' | 'delivered';
  rider?: RiderInfo;
  coordinates?: DeliveryCoordinates;
  notes?: string;
}

export interface StaffDeliveriesResponse {
  pending: StaffDeliveryItem[];
  mine: StaffDeliveryItem[];
}

export interface StaffReservationItem {
  id: string;
  customer_name: string;
  phone: string;
  party_size: number;
  reserved_at: string;
  table_no: string | null;
  status: 'pending' | 'confirmed' | 'arrived' | 'cancelled';
  notes: string;
}

export interface CareResource {
  title: string;
  description: string;
  url: string;
  phone: string;
  region: string;
}

// ----------------------------------------------------
// 7.3 Boss / Team Endpoints Models
// ----------------------------------------------------

export interface TeamMember {
  id: string;
  name: string;
  position: string;
  phone: string;
  email: string;
  employment_type: 'full_time' | 'part_time' | 'contract';
  hourly_rate: string;
  hired_at: string;
  birthday?: string | null;
  emergency_contact?: string;
  status: 'active' | 'leave' | 'inactive';
  is_active: boolean;
  user_id: string | null;
  has_account: boolean;
}

export interface TeamAttendanceAuditRecord {
  id: string;
  staff_id: string;
  staff_name: string;
  clock_in_at: string;
  clock_out_at: string | null;
  worked_minutes: number | null;
  clock_in_source: string;
  audit_reason?: string;
}

export interface CareSignal {
  id: string;
  staff_id: string;
  staff_name: string;
  kind: 'birthday' | 'consecutive_days' | 'overtime' | 'long_shift' | 'anniversary' | 'missed_clock';
  title: string;
  detail: string;
  due_at: string;
  status: 'open' | 'accepted' | 'dismissed' | 'awaiting_approval';
  action_type?: 'gift_voucher' | 'schedule_break' | 'check_in_note';
}

export interface CareNote {
  id: string;
  staff_id: string;
  author_id: string;
  author_name: string;
  kind: 'one_on_one' | 'check_in' | 'recognition';
  content: string;
  created_at: string;
}
