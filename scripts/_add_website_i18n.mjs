/**
 * Phase 17 —— 往三语 messages 里加 `nav.website` / `site` / `website` 三个命名空间。
 *
 * 为什么用脚本而不是手改 JSON：三份文件必须逐键对齐（tests/i18n-parity.test.ts
 * 会守），手改三遍是最容易漏一处的地方。脚本先断言三份都能 round-trip 成
 * 完全相同的字节，再写入 —— 这样 diff 只包含真正新增的键。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const LOCALES = ['en', 'zh', 'es'];

const SITE = {
  en: {
    backend: 'Backend',
    order: 'Order now',
    orderFull: 'Start an order',
    reserve: 'Reserve a table',
    reserveHint: 'Send a request and we will confirm shortly.',
    about: 'About us',
    menu: 'Menu',
    contact: 'Find us',
    hours: 'Opening hours',
    phone: 'Phone',
    email: 'Email',
    address: 'Address',
    fieldName: 'Your name',
    fieldPhone: 'Phone',
    fieldParty: 'Guests',
    fieldWhen: 'Date and time',
    fieldNotes: 'Anything we should know?',
    bookNow: 'Request reservation',
    booking: 'Sending…',
    bookDone: 'Thank you — your request has been sent. We will confirm shortly.',
    bookFailed: 'That did not go through. Please try again or call us.',
  },
  zh: {
    backend: '后台管理',
    order: '立即下单',
    orderFull: '开始点单',
    reserve: '预约订座',
    reserveHint: '提交后我们会尽快与您确认。',
    about: '关于我们',
    menu: '菜单',
    contact: '找到我们',
    hours: '营业时间',
    phone: '电话',
    email: '邮箱',
    address: '地址',
    fieldName: '您的称呼',
    fieldPhone: '联系电话',
    fieldParty: '用餐人数',
    fieldWhen: '到店时间',
    fieldNotes: '其他需要我们知道的事',
    bookNow: '提交预约',
    booking: '提交中…',
    bookDone: '已收到您的预约，我们会尽快与您确认。',
    bookFailed: '提交没有成功，请重试或直接致电我们。',
  },
  es: {
    backend: 'Panel',
    order: 'Pedir ahora',
    orderFull: 'Hacer un pedido',
    reserve: 'Reservar mesa',
    reserveHint: 'Envíe una solicitud y le confirmaremos en breve.',
    about: 'Sobre nosotros',
    menu: 'Carta',
    contact: 'Encuéntrenos',
    hours: 'Horario',
    phone: 'Teléfono',
    email: 'Correo',
    address: 'Dirección',
    fieldName: 'Su nombre',
    fieldPhone: 'Teléfono',
    fieldParty: 'Comensales',
    fieldWhen: 'Fecha y hora',
    fieldNotes: '¿Algo que debamos saber?',
    bookNow: 'Solicitar reserva',
    booking: 'Enviando…',
    bookDone: 'Gracias — hemos recibido su solicitud. Le confirmaremos en breve.',
    bookFailed: 'No se pudo enviar. Inténtelo de nuevo o llámenos.',
  },
};

const WEBSITE = {
  en: {
    title: 'Website',
    subtitle: 'Let the AI draft a public site from your own store data, then publish it under your own address.',
    generate: 'Draft with AI',
    regenerating: 'Drafting…',
    regenerate: 'Draft again',
    preview: 'Preview',
    openSite: 'Open the live site',
    notGenerated: 'No site yet. Start with “Draft with AI”.',
    draft: 'Draft',
    live: 'Published',
    publish: 'Publish',
    unpublish: 'Unpublish',
    saving: 'Saving…',
    save: 'Save',
    saved: 'Saved',
    saveError: 'Could not save',
    address: 'Public address',
    addressHint: 'Lowercase letters, digits and hyphens. This becomes /site/<address>.',
    domain: 'Your own domain',
    domainHint: 'Point a CNAME or A record here first, then enter the hostname. The certificate is issued automatically once DNS resolves.',
    domainEmpty: 'Not set — using the platform address only',
    orderLink: 'Online ordering link',
    orderLinkHint: 'The “Order now” button hands off to the existing ordering app, which prices every order on the server.',
    orderLinkMissing: 'Not ready yet — publish the site first.',
    aiNote: 'Generated text is a draft. Phone, address and email are always taken from your settings, never from the model.',
    sections: 'Sections',
    contactNote: 'Contact details come from Settings → Business.',
  },
  zh: {
    title: '官网',
    subtitle: '让 AI 按你自己店铺的数据起草官网，确认后再发布到你的地址上。',
    generate: 'AI 起草',
    regenerating: '起草中…',
    regenerate: '重新起草',
    preview: '预览',
    openSite: '打开线上官网',
    notGenerated: '还没有官网。先点「AI 起草」。',
    draft: '草稿',
    live: '已发布',
    publish: '发布',
    unpublish: '取消发布',
    saving: '保存中…',
    save: '保存',
    saved: '已保存',
    saveError: '保存失败',
    address: '公开地址',
    addressHint: '小写字母、数字、连字符。最终路径为 /site/<地址>。',
    domain: '你自己的域名',
    domainHint: '先把 CNAME 或 A 记录指向本服务器，再填主机名。DNS 生效后证书自动签发。',
    domainEmpty: '未设置 —— 仅使用平台地址',
    orderLink: '在线点单链接',
    orderLinkHint: '「立即下单」直接交给现成的点餐应用，每一单的价格都由服务端计算。',
    orderLinkMissing: '尚未就绪 —— 先发布官网。',
    aiNote: 'AI 生成的是草稿。电话、地址、邮箱一律取自你的设置，不采用模型给出的值。',
    sections: '页面分区',
    contactNote: '联系信息来自「设置 → 店铺资料」。',
  },
  es: {
    title: 'Sitio web',
    subtitle: 'Deje que la IA redacte un sitio público con los datos de su negocio y publíquelo en su propia dirección.',
    generate: 'Redactar con IA',
    regenerating: 'Redactando…',
    regenerate: 'Redactar de nuevo',
    preview: 'Vista previa',
    openSite: 'Abrir el sitio publicado',
    notGenerated: 'Todavía no hay sitio. Empiece con «Redactar con IA».',
    draft: 'Borrador',
    live: 'Publicado',
    publish: 'Publicar',
    unpublish: 'Despublicar',
    saving: 'Guardando…',
    save: 'Guardar',
    saved: 'Guardado',
    saveError: 'No se pudo guardar',
    address: 'Dirección pública',
    addressHint: 'Minúsculas, dígitos y guiones. Será /site/<dirección>.',
    domain: 'Su propio dominio',
    domainHint: 'Apunte antes un registro CNAME o A a este servidor y escriba el nombre de host. El certificado se emite solo cuando el DNS resuelva.',
    domainEmpty: 'Sin definir — solo la dirección de la plataforma',
    orderLink: 'Enlace de pedidos en línea',
    orderLinkHint: 'El botón «Pedir ahora» pasa a la aplicación de pedidos existente, que calcula cada precio en el servidor.',
    orderLinkMissing: 'Aún no está listo — publique el sitio primero.',
    aiNote: 'El texto generado es un borrador. El teléfono, la dirección y el correo siempre salen de su configuración, nunca del modelo.',
    sections: 'Secciones',
    contactNote: 'Los datos de contacto provienen de Configuración → Negocio.',
  },
};

const NAV_WEBSITE = { en: 'Website', zh: '官网', es: 'Sitio web' };

let failed = false;
for (const locale of LOCALES) {
  const file = `messages/${locale}.json`;
  const raw = readFileSync(file, 'utf8');
  const obj = JSON.parse(raw);

  const roundTrip = JSON.stringify(obj, null, 2) + (raw.endsWith('\n') ? '\n' : '');
  if (roundTrip !== raw) {
    console.error(`${file}: round-trip is not byte-identical — refusing to write`);
    failed = true;
    continue;
  }
  if (!obj.nav || typeof obj.nav !== 'object') {
    console.error(`${file}: missing "nav" namespace`);
    failed = true;
    continue;
  }
  if (obj.site || obj.website) {
    console.error(`${file}: "site"/"website" already exists — refusing to overwrite`);
    failed = true;
    continue;
  }

  obj.nav.website = NAV_WEBSITE[locale];
  obj.site = SITE[locale];
  obj.website = WEBSITE[locale];

  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  console.log(`${file}: +nav.website +site(${Object.keys(SITE[locale]).length}) +website(${Object.keys(WEBSITE[locale]).length})`);
}

process.exit(failed ? 1 : 0);
