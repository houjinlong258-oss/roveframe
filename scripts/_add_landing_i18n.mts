/**
 * 为 messages/*.json 增加 `landing` 命名空间（三语同步）。
 *
 * 为什么用脚本：本仓库硬约束"三语必须同步"，漏一个语言会在运行时抛
 * MISSING_MESSAGE。脚本保证三个文件一起改，并在写入前断言该命名空间不存在，
 * 避免静默覆盖已有翻译。
 *
 * 注意：next-intl 的键**不能含点号**，因此 `features.agent.title` 这类
 * 必须写成嵌套对象，不能写成平铺的点号键（见 AGENTS.md 陷阱 6）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Bundle = Record<string, unknown>;

const EN: Bundle = {
  badge: 'AI Chief Operating Officer for small business',
  heroTitle: 'Your business, run by an AI COO that actually does the work',
  heroSubtitle:
    'RoveFrame reads your real business data, finds what needs attention, proposes the fix, '
    + 'and — once you approve — executes it. Every action is frozen, approved and audited.',
  startFree: 'Start free',
  signIn: 'Sign in',
  noCard: 'No credit card required. Connect your own AI provider or use the platform model.',
  loopTitle: 'The loop the product actually closes',
  loopSubtitle:
    'Not a chat window bolted onto a dashboard. Each step below is a real component you can inspect.',
  loop: {
    data: 'Business data',
    insight: 'AI insight',
    recommend: 'Recommendation',
    approve: 'Your approval',
    execute: 'Real execution',
    audit: 'Audit trail',
  },
  featuresTitle: 'What it does',
  features: {
    agent: {
      title: 'Ask in plain language',
      body: 'A real agent runtime with tools. It queries your orders, customers and inventory instead of guessing.',
    },
    insight: {
      title: 'Operating dashboard',
      body: 'Revenue, channels, top items and anomalies, computed from your own records.',
    },
    approval: {
      title: 'Approve before it acts',
      body: 'Risky actions are frozen with their exact arguments and wait for a human decision.',
    },
    mail: {
      title: 'Real email, per customer',
      body: 'Individualised campaigns over your own SMTP or Gmail/Outlook, with delivery state per recipient.',
    },
    customers: {
      title: 'Customer intelligence',
      body: '360 view, churn risk and win-back candidates segmented from real spending history.',
    },
    reviews: {
      title: 'Review handling',
      body: 'Classify reviews, draft replies, and post them after approval.',
    },
    store: {
      title: 'QR ordering storefront',
      body: 'A public menu per table code, with orders priced server-side against your product list.',
    },
    audit: {
      title: 'Everything is auditable',
      body: 'Every tool call passes a policy gate and is recorded, alongside a per-business audit trail.',
    },
  },
  pricingTitle: 'Pricing',
  pricingSubtitle: 'Per business, not per seat. Bring your own AI provider key and pay them directly.',
  popular: 'Most popular',
  perMonth: '/mo',
  pricing: {
    starter: {
      name: 'Starter',
      price: '$29',
      blurb: 'One location getting started with AI operations.',
      a: '1 business, 1 storefront',
      b: 'AI agent with business tools',
      c: 'Approval workflow and audit trail',
    },
    growth: {
      name: 'Growth',
      price: '$79',
      blurb: 'For operators who want campaigns and inventory in the loop.',
      a: 'Everything in Starter',
      b: 'Campaigns, inventory and review handling',
      c: 'Scheduled briefings and alerts',
    },
    scale: {
      name: 'Scale',
      price: '$199',
      blurb: 'Multi-location and integration-heavy operations.',
      a: 'Everything in Growth',
      b: 'POS / ERP connectivity',
      c: 'Priority support and onboarding',
    },
  },
  pricingNote:
    'Indicative pricing — confirm before publishing. Figures are placeholders pending a business decision.',
  ctaTitle: 'Start with your own data',
  ctaSubtitle:
    'Create an account, connect a provider, and ask your first question about the business in minutes.',
  footer: 'RoveFrame — AI Business OS',
};

const ZH: Bundle = {
  badge: '面向中小企业的 AI 首席运营官',
  heroTitle: '让一个真正干活的 AI COO 替你经营',
  heroSubtitle:
    'RoveFrame 读取你的真实经营数据，找出需要处理的事，给出方案；'
    + '你批准之后它才执行。每一步都被冻结、审批、留痕。',
  startFree: '免费开始',
  signIn: '登录',
  noCard: '无需信用卡。可接入你自己的模型服务商，也可使用平台内置模型。',
  loopTitle: '产品真正闭环的那条链路',
  loopSubtitle: '不是给仪表盘加一个聊天框。下面每一步都是你可以查验的真实组件。',
  loop: {
    data: '经营数据',
    insight: 'AI 洞察',
    recommend: '行动建议',
    approve: '你的审批',
    execute: '真实执行',
    audit: '审计留痕',
  },
  featuresTitle: '能力',
  features: {
    agent: {
      title: '用大白话提问',
      body: '真实 Agent 运行时带工具。它去查你的订单、客户与库存，而不是猜。',
    },
    insight: {
      title: '经营仪表盘',
      body: '营收、渠道、热销与异常，全部由你自己的记录算出来。',
    },
    approval: {
      title: '先批准，再动手',
      body: '高风险动作连同**确切参数**一起冻结，等人决定。',
    },
    mail: {
      title: '真实邮件，逐人个性化',
      body: '走你自己的 SMTP 或 Gmail/Outlook，每个收件人都有投递状态。',
    },
    customers: {
      title: '客户智能',
      body: '360 视图、流失风险与召回名单，按真实消费历史切分。',
    },
    reviews: {
      title: '评论处理',
      body: '自动分类、起草回复，批准后再发布。',
    },
    store: {
      title: '扫码点餐商城',
      body: '一桌一码的公开菜单，订单在服务端按你的商品表计价。',
    },
    audit: {
      title: '全程可审计',
      body: '每次工具调用都过一个策略闸门并被记录，另有按商家分开的审计流水。',
    },
  },
  pricingTitle: '价格',
  pricingSubtitle: '按商家计费，不按人头。自带模型服务商 Key，直接付给服务商。',
  popular: '最常见的选择',
  perMonth: '/月',
  pricing: {
    starter: {
      name: '入门',
      price: '$29',
      blurb: '单店起步，先把 AI 经营跑起来。',
      a: '1 个商家、1 个店面',
      b: '带业务工具的 AI Agent',
      c: '审批流与审计留痕',
    },
    growth: {
      name: '成长',
      price: '$79',
      blurb: '要把营销与库存也纳入闭环的经营者。',
      a: '含入门版全部',
      b: '营销活动、库存与评论处理',
      c: '定时经营简报与异常告警',
    },
    scale: {
      name: '规模',
      price: '$199',
      blurb: '多门店、重集成的经营场景。',
      a: '含成长版全部',
      b: 'POS / ERP 对接',
      c: '优先支持与上线协助',
    },
  },
  pricingNote: '参考价，发布前请确认。当前数字为占位，待业务方定价。',
  ctaTitle: '用你自己的数据开始',
  ctaSubtitle: '注册、接入服务商，几分钟内问出第一个关于经营的问题。',
  footer: 'RoveFrame — AI Business OS',
};

const ES: Bundle = {
  badge: 'Director de Operaciones con IA para pymes',
  heroTitle: 'Tu negocio, dirigido por un COO de IA que realmente hace el trabajo',
  heroSubtitle:
    'RoveFrame lee los datos reales de tu negocio, detecta lo que requiere atención, '
    + 'propone la solución y —tras tu aprobación— la ejecuta. Cada acción queda congelada, '
    + 'aprobada y auditada.',
  startFree: 'Empezar gratis',
  signIn: 'Iniciar sesión',
  noCard: 'Sin tarjeta de crédito. Conecta tu propio proveedor de IA o usa el modelo de la plataforma.',
  loopTitle: 'El ciclo que el producto realmente cierra',
  loopSubtitle:
    'No es un chat añadido a un panel. Cada paso de abajo es un componente real que puedes inspeccionar.',
  loop: {
    data: 'Datos del negocio',
    insight: 'Análisis con IA',
    recommend: 'Recomendación',
    approve: 'Tu aprobación',
    execute: 'Ejecución real',
    audit: 'Registro de auditoría',
  },
  featuresTitle: 'Qué hace',
  features: {
    agent: {
      title: 'Pregunta en lenguaje natural',
      body: 'Un runtime de agente real con herramientas: consulta tus pedidos, clientes e inventario en vez de adivinar.',
    },
    insight: {
      title: 'Panel operativo',
      body: 'Ingresos, canales, productos destacados y anomalías, calculados desde tus propios registros.',
    },
    approval: {
      title: 'Aprueba antes de actuar',
      body: 'Las acciones de riesgo se congelan con sus argumentos exactos y esperan una decisión humana.',
    },
    mail: {
      title: 'Correo real, por cliente',
      body: 'Campañas individualizadas por tu propio SMTP o Gmail/Outlook, con estado por destinatario.',
    },
    customers: {
      title: 'Inteligencia de clientes',
      body: 'Vista 360, riesgo de abandono y candidatos de recuperación según el historial real de gasto.',
    },
    reviews: {
      title: 'Gestión de reseñas',
      body: 'Clasifica reseñas, redacta respuestas y publícalas tras la aprobación.',
    },
    store: {
      title: 'Tienda con pedido por QR',
      body: 'Menú público por código de mesa, con precios calculados en el servidor según tu catálogo.',
    },
    audit: {
      title: 'Todo es auditable',
      body: 'Cada llamada a herramienta pasa por una política y queda registrada, con trazabilidad por negocio.',
    },
  },
  pricingTitle: 'Precios',
  pricingSubtitle: 'Por negocio, no por usuario. Usa tu propia clave de proveedor de IA y págale directamente.',
  popular: 'Más elegido',
  perMonth: '/mes',
  pricing: {
    starter: {
      name: 'Inicial',
      price: '$29',
      blurb: 'Un local que empieza con operaciones de IA.',
      a: '1 negocio, 1 tienda',
      b: 'Agente de IA con herramientas de negocio',
      c: 'Flujo de aprobación y auditoría',
    },
    growth: {
      name: 'Crecimiento',
      price: '$79',
      blurb: 'Para quien quiere campañas e inventario dentro del ciclo.',
      a: 'Todo lo de Inicial',
      b: 'Campañas, inventario y gestión de reseñas',
      c: 'Informes programados y alertas',
    },
    scale: {
      name: 'Escala',
      price: '$199',
      blurb: 'Operaciones con varias sedes y muchas integraciones.',
      a: 'Todo lo de Crecimiento',
      b: 'Conectividad POS / ERP',
      c: 'Soporte prioritario y puesta en marcha',
    },
  },
  pricingNote: 'Precio indicativo: confírmalo antes de publicar. Las cifras son provisionales.',
  ctaTitle: 'Empieza con tus propios datos',
  ctaSubtitle: 'Crea una cuenta, conecta un proveedor y haz tu primera pregunta en minutos.',
  footer: 'RoveFrame — AI Business OS',
};

const BUNDLES: Record<string, Bundle> = { en: EN, zh: ZH, es: ES };

function main(): number {
  for (const [loc, bundle] of Object.entries(BUNDLES)) {
    const path = join(process.cwd(), 'messages', `${loc}.json`);
    const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if ('landing' in json) {
      console.log(`  [${loc}] landing 已存在，跳过（不覆盖已有翻译）`);
      continue;
    }
    json.landing = bundle;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    console.log(`  [${loc}] + landing (${Object.keys(bundle).length} 顶层键)`);
  }
  console.log('完成：三语 landing 命名空间已写入。');
  return 0;
}

process.exitCode = main();
