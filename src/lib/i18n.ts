/**
 * Phase 18 Internationalization (i18n) Dictionary
 * Strictly follows §8.1 namespaces: store, site, website, nav, staff, team, care, delivery
 * With 100% structural parity across zh, en, and es. No dots in keys.
 */

import { Locale } from '../types';

export interface I18nSchema {
  nav: {
    dashboard: string;
    team: string;
    care: string;
    website: string;
    settings: string;
    customer_app: string;
    staff_app: string;
    spec_inspector: string;
  };
  store: {
    dine_in: string;
    delivery: string;
    booking: string;
    menu_only: string;
    table_label: string;
    add_to_cart: string;
    cart: string;
    cart_empty: string;
    checkout: string;
    subtotal: string;
    tip: string;
    notes: string;
    notes_placeholder: string;
    order_success: string;
    order_no: string;
    login_prompt: string;
    my_orders: string;
    view_details: string;
    item_count: string;
    sales_count: string;
  };
  delivery: {
    recipient_name: string;
    recipient_phone: string;
    address_line: string;
    address_note: string;
    address_placeholder: string;
    min_order_tip: string;
    delivery_fee: string;
    free_delivery_badge: string;
    prep_time_prefix: string;
    prep_time_unit: string;
    not_enabled: string;
    save_to_book: string;
    saved_addresses: string;
    order_placed: string;
    status_pending: string;
    status_claimed: string;
    status_picked_up: string;
    status_delivered: string;
    track_delivery: string;
    rider_info: string;
    live_map: string;
    eta_prefix: string;
    contact_rider: string;
    delivery_route: string;
  };
  site: {
    reserve_table: string;
    party_size: string;
    date_time: string;
    contact_name: string;
    contact_phone: string;
    special_requests: string;
    submit_booking: string;
    booking_success: string;
    window_limit_tip: string;
    opening_hours: string;
  };
  staff: {
    login_title: string;
    login_desc: string;
    email: string;
    password: string;
    login_button: string;
    remember_me: string;
    not_linked_error: string;
    nav_today: string;
    nav_clock: string;
    nav_shifts: string;
    nav_deliveries: string;
    nav_reservations: string;
    nav_me: string;
    clock_in: string;
    clock_out: string;
    status_clocked_in: string;
    status_not_clocked: string;
    my_shifts_today: string;
    no_shifts_today: string;
    pending_deliveries: string;
    no_deliveries: string;
    pending_reservations: string;
    no_reservations: string;
    shifts_14_days: string;
    shifts_empty: string;
    claim_delivery: string;
    claimed_by_other: string;
    my_deliveries: string;
    mark_picked_up: string;
    mark_delivered: string;
    call_customer: string;
    confirm_reservation: string;
    mark_arrived: string;
    cancel_reservation: string;
    privacy_opt_in: string;
    privacy_opt_in_desc: string;
    export_my_data: string;
    care_resources: string;
    logout: string;
    staff_profile: string;
  };
  team: {
    tab_directory: string;
    tab_scheduling: string;
    tab_attendance: string;
    add_member: string;
    edit_member: string;
    invite_account: string;
    invite_success: string;
    name: string;
    position: string;
    phone: string;
    email: string;
    employment_type: string;
    hourly_rate: string;
    hire_date: string;
    birthday: string;
    birthday_sensitive_tip: string;
    status: string;
    retro_clock: string;
    retro_reason_label: string;
    retro_reason_required: string;
    submit_retro: string;
    shift_add: string;
    role: string;
    notes: string;
  };
  care: {
    ai_todo_title: string;
    ai_todo_desc: string;
    accept: string;
    dismiss: string;
    awaiting_approval: string;
    approved: string;
    care_notes_title: string;
    care_notes_desc: string;
    new_note: string;
    note_content: string;
    save_note: string;
    resource_library: string;
    copy_link: string;
    copied: string;
    privacy_guarantee: string;
  };
  website: {
    site_title: string;
    site_subtitle: string;
    theme_color: string;
    enable_delivery: string;
    enable_booking: string;
    save_config: string;
    saved_success: string;
  };
}

export const translations: Record<Locale, I18nSchema> = {
  zh: {
    nav: {
      dashboard: '控制台',
      team: '员工管理',
      care: '员工关怀',
      website: '官网管理',
      settings: '设置',
      customer_app: '顾客端 PWA',
      staff_app: '员工端 PWA',
      spec_inspector: '施工规格与契约',
    },
    store: {
      dine_in: '堂食点单',
      delivery: '外卖配送',
      booking: '订座预约',
      menu_only: '浏览菜单',
      table_label: '桌号',
      add_to_cart: '加入清单',
      cart: '选购清单',
      cart_empty: '清单空空如也，挑选心仪菜品吧',
      checkout: '立即下单',
      subtotal: '菜品小计',
      tip: '服务小费',
      notes: '订单备注',
      notes_placeholder: '口味偏好、过敏提示或特殊要求',
      order_success: '下单成功！',
      order_no: '订单编号',
      login_prompt: '登录查看订单与常用地址',
      my_orders: '我的订单',
      view_details: '查看详情',
      item_count: '项商品',
      sales_count: '已售',
    },
    delivery: {
      recipient_name: '收餐人姓名',
      recipient_phone: '联系电话',
      address_line: '配送详细地址',
      address_note: '门牌号 / 楼栋 / 备用说明',
      address_placeholder: '如：幸福路88号阳光大厦A座1201',
      min_order_tip: '还差 {diff} 起送',
      delivery_fee: '配送费',
      free_delivery_badge: '已免配送费',
      prep_time_prefix: '约',
      prep_time_unit: '分钟送达',
      not_enabled: '本店暂未开启外卖配送',
      save_to_book: '保存至我的常用地址',
      saved_addresses: '选择常用地址',
      order_placed: '外卖订单已提交',
      status_pending: '等待骑手接单',
      status_claimed: '骑手已接单前往餐厅',
      status_picked_up: '骑手已取餐配送中',
      status_delivered: '已送达，用餐愉快',
      track_delivery: '实时配送追踪与地图',
      rider_info: '外卖专职骑手信息',
      live_map: '配送路线实时地图',
      eta_prefix: '预计送达',
      contact_rider: '联系骑手',
      delivery_route: '配送路线与经纬度',
    },
    site: {
      reserve_table: '预定座位',
      party_size: '就餐人数',
      date_time: '到店时间',
      contact_name: '联系人称呼',
      contact_phone: '手机号码',
      special_requests: '特别安排备注',
      submit_booking: '确认提交预约',
      booking_success: '预约已提交，餐厅将尽快确认',
      window_limit_tip: '可预约时间为 1 小时后至 180 天以内',
      opening_hours: '营业时间',
    },
    staff: {
      login_title: '员工工作台登录',
      login_desc: '使用店内分配的工作账号登录系统',
      email: '工作邮箱',
      password: '登录密码',
      login_button: '登录工作台',
      remember_me: '保持登录状态',
      not_linked_error: '你的账号还没关联员工档案，请联系店长',
      nav_today: '今日',
      nav_clock: '考勤打卡',
      nav_shifts: '我的排班',
      nav_deliveries: '外卖派单',
      nav_reservations: '预约确认',
      nav_me: '我的',
      clock_in: '上班打卡',
      clock_out: '下班打卡',
      status_clocked_in: '已打卡上班',
      status_not_clocked: '今日尚未打卡',
      my_shifts_today: '今日班次',
      no_shifts_today: '今天没有排班，好好休息',
      pending_deliveries: '待接外卖单',
      no_deliveries: '暂时没有待接外卖单',
      pending_reservations: '待确认预约',
      no_reservations: '今天没有待确认的预约',
      shifts_14_days: '未来14天排班表',
      shifts_empty: '未来14天暂无排班',
      claim_delivery: '立即接单',
      claimed_by_other: '已被其他同事接走',
      my_deliveries: '我的配送任务',
      mark_picked_up: '确认已取餐',
      mark_delivered: '确认已送达',
      call_customer: '联系顾客',
      confirm_reservation: '确认预定',
      mark_arrived: '标记到店',
      cancel_reservation: '取消预约',
      privacy_opt_in: '允许记录我的生日等个性化信息',
      privacy_opt_in_desc: '默认关闭，由员工本人自主开启。开启后店长可关怀生日或周年纪念',
      export_my_data: '下载我的个人数据 (JSON)',
      care_resources: '员工身心健康支持资源',
      logout: '退出当前员工账号',
      staff_profile: '员工资料（只读）',
    },
    team: {
      tab_directory: '员工档案',
      tab_scheduling: '排班管理',
      tab_attendance: '考勤明细',
      add_member: '新增员工',
      edit_member: '编辑档案',
      invite_account: '邀请开通账号',
      invite_success: '邀请链接已生成，已复制到剪贴板',
      name: '姓名',
      position: '岗位职责',
      phone: '联系手机',
      email: '电子邮箱',
      employment_type: '用工形式',
      hourly_rate: '标准时薪',
      hire_date: '入职日期',
      birthday: '出生日期',
      birthday_sensitive_tip: '生日属于敏感隐私信息，员工可在其个人端自主关闭记录',
      status: '在职状态',
      retro_clock: '店长补卡',
      retro_reason_label: '补卡审核原因（必填，计入审计日志）',
      retro_reason_required: '必须填写补卡原因以符合考勤合规审计要求',
      submit_retro: '确认提交补卡',
      shift_add: '安排班次',
      role: '工作岗位',
      notes: '排班说明',
    },
    care: {
      ai_todo_title: 'AI 关怀待办与信号',
      ai_todo_desc: '基于工时、班次与纪念日自动识别的关怀触发信号',
      accept: '采纳建议',
      dismiss: '忽略提示',
      awaiting_approval: '等待审批中',
      approved: '已审批执行',
      care_notes_title: '关怀沟通记录',
      care_notes_desc: '仅显示您本人创建或关于您的谈话，严格保障员工隐私安全',
      new_note: '新增关怀谈心记录',
      note_content: '沟通内容与关怀小记',
      save_note: '保存记录',
      resource_library: '心理支持与关怀资源库',
      copy_link: '复制推荐链接',
      copied: '已复制链接',
      privacy_guarantee: '隐私硬约束：本页不提供任何心理打分、情绪测验或问卷，仅做正规外部转介',
    },
    website: {
      site_title: '商家对外微官网',
      site_subtitle: '配置对外展示的订餐模式、品牌主题色及配送门槛',
      theme_color: '品牌主题色',
      enable_delivery: '开启外卖功能',
      enable_booking: '开启座位预约功能',
      save_config: '保存配置',
      saved_success: '微官网配置已更新',
    },
  },
  en: {
    nav: {
      dashboard: 'Dashboard',
      team: 'Team Management',
      care: 'Staff Care',
      website: 'Public Website',
      settings: 'Settings',
      customer_app: 'Customer PWA',
      staff_app: 'Staff PWA',
      spec_inspector: 'Construction Spec',
    },
    store: {
      dine_in: 'Dine-in Order',
      delivery: 'Delivery',
      booking: 'Reservation',
      menu_only: 'Browse Menu',
      table_label: 'Table',
      add_to_cart: 'Add to Cart',
      cart: 'Your Cart',
      cart_empty: 'Your cart is empty. Pick some delicious items!',
      checkout: 'Place Order',
      subtotal: 'Item Subtotal',
      tip: 'Staff Tip',
      notes: 'Order Notes',
      notes_placeholder: 'Dietary preferences, allergies, or special requests',
      order_success: 'Order placed successfully!',
      order_no: 'Order No',
      login_prompt: 'Sign in to track orders and save addresses',
      my_orders: 'My Orders',
      view_details: 'View Details',
      item_count: 'items',
      sales_count: 'sold',
    },
    delivery: {
      recipient_name: 'Recipient Name',
      recipient_phone: 'Phone Number',
      address_line: 'Delivery Address',
      address_note: 'Apartment, suite, or delivery notes',
      address_placeholder: 'e.g. 1201 Sunshine Tower, 88 Market St',
      min_order_tip: '{diff} more to reach minimum order',
      delivery_fee: 'Delivery Fee',
      free_delivery_badge: 'Free Delivery',
      prep_time_prefix: 'Approx.',
      prep_time_unit: 'mins to arrive',
      not_enabled: 'Delivery service is currently disabled',
      save_to_book: 'Save to my address book',
      saved_addresses: 'Saved Addresses',
      order_placed: 'Delivery order submitted',
      status_pending: 'Waiting for rider',
      status_claimed: 'Rider claimed order',
      status_picked_up: 'Order picked up and on route',
      status_delivered: 'Delivered. Enjoy your meal!',
      track_delivery: 'Live Delivery Tracking & Map',
      rider_info: 'Dedicated Rider Information',
      live_map: 'Live Delivery Route Map',
      eta_prefix: 'Estimated Arrival',
      contact_rider: 'Contact Rider',
      delivery_route: 'Route & Coordinates',
    },
    site: {
      reserve_table: 'Book a Table',
      party_size: 'Party Size',
      date_time: 'Arrival Time',
      contact_name: 'Contact Name',
      contact_phone: 'Phone Number',
      special_requests: 'Special Requests',
      submit_booking: 'Confirm Reservation',
      booking_success: 'Reservation submitted. The restaurant will confirm shortly',
      window_limit_tip: 'Booking window must be between 1 hour and 180 days in advance',
      opening_hours: 'Opening Hours',
    },
    staff: {
      login_title: 'Staff Portal Login',
      login_desc: 'Sign in with your restaurant staff credentials',
      email: 'Work Email',
      password: 'Password',
      login_button: 'Sign In',
      remember_me: 'Remember me',
      not_linked_error: 'Your account is not linked to a staff profile. Please contact your manager.',
      nav_today: 'Today',
      nav_clock: 'Clock In',
      nav_shifts: 'My Shifts',
      nav_deliveries: 'Deliveries',
      nav_reservations: 'Reservations',
      nav_me: 'Profile',
      clock_in: 'Clock In',
      clock_out: 'Clock Out',
      status_clocked_in: 'Clocked In',
      status_not_clocked: 'Not Clocked In Today',
      my_shifts_today: "Today's Shift",
      no_shifts_today: 'No scheduled shifts today. Enjoy your break!',
      pending_deliveries: 'Pending Deliveries',
      no_deliveries: 'No pending deliveries right now',
      pending_reservations: 'Pending Bookings',
      no_reservations: 'No pending reservations today',
      shifts_14_days: 'Next 14 Days Schedule',
      shifts_empty: 'No scheduled shifts in the next 14 days',
      claim_delivery: 'Claim Delivery',
      claimed_by_other: 'Claimed by another colleague',
      my_deliveries: 'My Active Deliveries',
      mark_picked_up: 'Mark as Picked Up',
      mark_delivered: 'Mark as Delivered',
      call_customer: 'Call Customer',
      confirm_reservation: 'Confirm Booking',
      mark_arrived: 'Mark Arrived',
      cancel_reservation: 'Cancel Booking',
      privacy_opt_in: 'Allow recording my birthday and personal information',
      privacy_opt_in_desc: 'Disabled by default. When enabled by you, managers can recognize birthdays and anniversaries',
      export_my_data: 'Export My Personal Data (JSON)',
      care_resources: 'Employee Wellness & Support Resources',
      logout: 'Sign Out',
      staff_profile: 'Staff Profile (Read-only)',
    },
    team: {
      tab_directory: 'Staff Directory',
      tab_scheduling: 'Shift Scheduling',
      tab_attendance: 'Attendance Log',
      add_member: 'Add Staff Member',
      edit_member: 'Edit Profile',
      invite_account: 'Invite Account',
      invite_success: 'Invitation link generated and copied to clipboard',
      name: 'Full Name',
      position: 'Role / Position',
      phone: 'Phone',
      email: 'Email',
      employment_type: 'Employment Type',
      hourly_rate: 'Hourly Rate',
      hire_date: 'Hire Date',
      birthday: 'Date of Birth',
      birthday_sensitive_tip: 'Birthday is sensitive info; employees may disable tracking in their personal settings',
      status: 'Status',
      retro_clock: 'Manager Retro Punch',
      retro_reason_label: 'Audit Reason (Required for compliance log)',
      retro_reason_required: 'A valid reason is required for labor audit compliance',
      submit_retro: 'Confirm Retro Clock',
      shift_add: 'Schedule Shift',
      role: 'Assigned Role',
      notes: 'Shift Notes',
    },
    care: {
      ai_todo_title: 'AI Care Signals & To-Dos',
      ai_todo_desc: 'Automated care triggers based on worked hours, consecutive shifts, and anniversaries',
      accept: 'Accept Suggestion',
      dismiss: 'Dismiss',
      awaiting_approval: 'Awaiting Approval',
      approved: 'Approved & Executed',
      care_notes_title: 'Care Interaction Notes',
      care_notes_desc: 'Only displays notes authored by you or concerning you to strictly protect employee privacy',
      new_note: 'Add 1-on-1 Care Note',
      note_content: 'Discussion Summary & Care Notes',
      save_note: 'Save Note',
      resource_library: 'Mental Health & Support Library',
      copy_link: 'Copy Resource Link',
      copied: 'Link Copied',
      privacy_guarantee: 'Privacy constraint: strictly no psychological tests, mood surveys, or questionnaires',
    },
    website: {
      site_title: 'Public Micro-Website',
      site_subtitle: 'Configure public ordering modes, brand primary color, and delivery limits',
      theme_color: 'Brand Primary Color',
      enable_delivery: 'Enable Delivery',
      enable_booking: 'Enable Table Booking',
      save_config: 'Save Configuration',
      saved_success: 'Micro-website settings updated successfully',
    },
  },
  es: {
    nav: {
      dashboard: 'Panel de Control',
      team: 'Gestión de Equipo',
      care: 'Bienestar del Personal',
      website: 'Sitio Web Público',
      settings: 'Configuración',
      customer_app: 'PWA Clientes',
      staff_app: 'PWA Empleados',
      spec_inspector: 'Especificaciones',
    },
    store: {
      dine_in: 'Consumir en el Local',
      delivery: 'A Domicilio',
      booking: 'Reservaciones',
      menu_only: 'Ver Menú',
      table_label: 'Mesa',
      add_to_cart: 'Añadir al Carrito',
      cart: 'Tu Carrito',
      cart_empty: 'Tu carrito está vacío. ¡Elige deliciosos platillos!',
      checkout: 'Confirmar Pedido',
      subtotal: 'Subtotal de Productos',
      tip: 'Propina del Personal',
      notes: 'Instrucciones del Pedido',
      notes_placeholder: 'Preferencias, alergias o peticiones especiales',
      order_success: '¡Pedido realizado con éxito!',
      order_no: 'N.º de Pedido',
      login_prompt: 'Inicia sesión para rastrear pedidos y guardar direcciones',
      my_orders: 'Mis Pedidos',
      view_details: 'Ver Detalles',
      item_count: 'artículos',
      sales_count: 'vendidos',
    },
    delivery: {
      recipient_name: 'Nombre del Destinatario',
      recipient_phone: 'Teléfono de Contacto',
      address_line: 'Dirección de Entrega',
      address_note: 'Piso, puerta o detalles de acceso',
      address_placeholder: 'ej. Av. Mayor 45, Edificio Sol, Puerta 3B',
      min_order_tip: 'Faltan {diff} para el pedido mínimo',
      delivery_fee: 'Costo de Envío',
      free_delivery_badge: 'Envío Gratis',
      prep_time_prefix: 'Aprox.',
      prep_time_unit: 'minutos en llegar',
      not_enabled: 'El servicio a domicilio no está habilitado actualmente',
      save_to_book: 'Guardar en mis direcciones',
      saved_addresses: 'Direcciones Guardadas',
      order_placed: 'Pedido a domicilio enviado',
      status_pending: 'Esperando repartidor',
      status_claimed: 'Repartidor asignado',
      status_picked_up: 'Pedido recogido y en camino',
      status_delivered: '¡Entregado! Buen provecho',
      track_delivery: 'Seguimiento en Vivo y Mapa',
      rider_info: 'Información del Repartidor',
      live_map: 'Mapa de Ruta en Vivo',
      eta_prefix: 'Llegada Estimada',
      contact_rider: 'Contactar Repartidor',
      delivery_route: 'Ruta y Coordenadas',
    },
    site: {
      reserve_table: 'Reservar una Mesa',
      party_size: 'Número de Comensales',
      date_time: 'Fecha y Hora',
      contact_name: 'Nombre de Contacto',
      contact_phone: 'Teléfono',
      special_requests: 'Peticiones Especiales',
      submit_booking: 'Confirmar Reservación',
      booking_success: 'Reservación enviada. El restaurante confirmará en breve',
      window_limit_tip: 'Las reservas deben hacerse con 1 hora y hasta 180 días de antelación',
      opening_hours: 'Horarios de Apertura',
    },
    staff: {
      login_title: 'Acceso para Empleados',
      login_desc: 'Inicia sesión con las credenciales asignadas por el restaurante',
      email: 'Correo de Trabajo',
      password: 'Contraseña',
      login_button: 'Iniciar Sesión',
      remember_me: 'Recordarme',
      not_linked_error: 'Tu cuenta aún no está asociada a un perfil de empleado. Contacta al gerente.',
      nav_today: 'Hoy',
      nav_clock: 'Fichar',
      nav_shifts: 'Mis Turnos',
      nav_deliveries: 'Repartos',
      nav_reservations: 'Reservas',
      nav_me: 'Mi Perfil',
      clock_in: 'Fichar Entrada',
      clock_out: 'Fichar Salida',
      status_clocked_in: 'Turno Activo',
      status_not_clocked: 'Sin fichar hoy',
      my_shifts_today: 'Turno de Hoy',
      no_shifts_today: 'No tienes turnos programados hoy. ¡Disfruta tu descanso!',
      pending_deliveries: 'Repartos Pendientes',
      no_deliveries: 'No hay pedidos pendientes de reparto',
      pending_reservations: 'Reservas Pendientes',
      no_reservations: 'No hay reservas pendientes hoy',
      shifts_14_days: 'Horario Próximos 14 Días',
      shifts_empty: 'Sin turnos en los próximos 14 días',
      claim_delivery: 'Tomar Pedido',
      claimed_by_other: 'Tomado por otro compañero',
      my_deliveries: 'Mis Repartos en Curso',
      mark_picked_up: 'Confirmar Recogida',
      mark_delivered: 'Confirmar Entrega',
      call_customer: 'Llamar al Cliente',
      confirm_reservation: 'Confirmar Reserva',
      mark_arrived: 'Marcar como Llegado',
      cancel_reservation: 'Cancelar Reserva',
      privacy_opt_in: 'Permitir registrar mi cumpleaños e información personal',
      privacy_opt_in_desc: 'Desactivado por defecto. Si lo activas, el gerente podrá reconocer cumpleaños y aniversarios',
      export_my_data: 'Descargar Mis Datos (JSON)',
      care_resources: 'Recursos de Bienestar y Asistencia al Empleado',
      logout: 'Cerrar Sesión',
      staff_profile: 'Perfil de Empleado (Solo lectura)',
    },
    team: {
      tab_directory: 'Plantilla de Empleados',
      tab_scheduling: 'Programación de Turnos',
      tab_attendance: 'Registro de Asistencia',
      add_member: 'Añadir Empleado',
      edit_member: 'Editar Ficha',
      invite_account: 'Invitar Cuenta',
      invite_success: 'Enlace de invitación generado y copiado al portapapeles',
      name: 'Nombre Completo',
      position: 'Puesto de Trabajo',
      phone: 'Teléfono',
      email: 'Correo Electrónico',
      employment_type: 'Tipo de Contrato',
      hourly_rate: 'Tarifa por Hora',
      hire_date: 'Fecha de Contratación',
      birthday: 'Fecha de Nacimiento',
      birthday_sensitive_tip: 'Dato sensible; el empleado puede desactivar su registro desde su configuración',
      status: 'Estado',
      retro_clock: 'Fichaje Retroactivo',
      retro_reason_label: 'Motivo del Fichaje (Obligatorio para auditoría)',
      retro_reason_required: 'Se requiere un motivo explícito para cumplir con la auditoría laboral',
      submit_retro: 'Guardar Fichaje',
      shift_add: 'Asignar Turno',
      role: 'Función Asignada',
      notes: 'Notas del Turno',
    },
    care: {
      ai_todo_title: 'Señales y Tareas de Cuidado IA',
      ai_todo_desc: 'Alertas automáticas basadas en horas extras, turnos consecutivos y aniversarios',
      accept: 'Aceptar Sugerencia',
      dismiss: 'Descartar',
      awaiting_approval: 'Esperando Aprobación',
      approved: 'Aprobado y Ejecutado',
      care_notes_title: 'Notas de Bienestar y Charlas',
      care_notes_desc: 'Solo muestra notas creadas por ti o sobre ti para proteger la privacidad',
      new_note: 'Añadir Nota de Charla 1 a 1',
      note_content: 'Resumen de la Conversación',
      save_note: 'Guardar Nota',
      resource_library: 'Biblioteca de Apoyo Emocional',
      copy_link: 'Copiar Enlace',
      copied: 'Enlace Copiado',
      privacy_guarantee: 'Garantía de privacidad: sin cuestionarios, tests emocionales ni puntuaciones',
    },
    website: {
      site_title: 'Micrositio Público',
      site_subtitle: 'Configura las modalidades activas, color primario y umbrales de entrega',
      theme_color: 'Color Primario de Marca',
      enable_delivery: 'Habilitar Servicio a Domicilio',
      enable_booking: 'Habilitar Reserva de Mesas',
      save_config: 'Guardar Configuración',
      saved_success: 'Configuración del sitio web actualizada con éxito',
    },
  },
};

export function getTranslations(locale: Locale): I18nSchema {
  return translations[locale] || translations.zh;
}
